import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { type GeoPoint, type Place, type PlaceSuggestion } from '@voyago/shared';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { HTTP_FETCH, type HttpFetch, PROVIDER_TIMEOUT_MS } from './http-fetch.js';

const PLACES_URL = 'https://places.googleapis.com/v1';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';
/** Bias (not restrict) results to Bengaluru, the launch city, within India. */
const LAUNCH_BIAS = { center: { latitude: 12.9716, longitude: 77.5946 }, radius: 50_000 };

const AutocompleteResponse = z.object({
  suggestions: z
    .array(
      z.object({
        placePrediction: z
          .object({
            placeId: z.string(),
            text: z.object({ text: z.string() }),
            structuredFormat: z
              .object({
                mainText: z.object({ text: z.string() }),
                secondaryText: z.object({ text: z.string() }).optional(),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

const PlaceResponse = z.object({
  id: z.string(),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  location: z.object({ latitude: z.number(), longitude: z.number() }),
});

const RoutesResponse = z.object({
  routes: z
    .array(z.object({ distanceMeters: z.number().int().default(0), duration: z.string() }))
    .default([]),
});

export interface ComputedRoute {
  distanceMeters: number;
  durationSeconds: number;
  travelMode: 'TWO_WHEELER' | 'DRIVE';
}

/**
 * Google Maps Platform, called only from the server so the key never reaches the apps.
 * Place search uses Places API (New); routes use the Routes API. Without GOOGLE_MAPS_API_KEY,
 * search returns 503 and routes are simply not computed.
 */
@Injectable()
export class GoogleMapsService {
  private readonly logger = new Logger(GoogleMapsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(HTTP_FETCH) private readonly fetchImpl: HttpFetch,
  ) {}

  get enabled(): boolean {
    return this.config.GOOGLE_MAPS_API_KEY.length > 0;
  }

  async autocomplete(input: string, sessionToken: string): Promise<PlaceSuggestion[]> {
    const body = await this.call(`${PLACES_URL}/places:autocomplete`, {
      method: 'POST',
      fieldMask: null,
      body: {
        input,
        sessionToken,
        includedRegionCodes: ['in'],
        locationBias: { circle: LAUNCH_BIAS },
        languageCode: 'en',
      },
    });
    return AutocompleteResponse.parse(body)
      .suggestions.flatMap((s) => (s.placePrediction ? [s.placePrediction] : []))
      .map((p) => ({
        placeId: p.placeId,
        primaryText: p.structuredFormat?.mainText.text ?? p.text.text,
        secondaryText: p.structuredFormat?.secondaryText?.text ?? null,
      }));
  }

  async placeDetails(placeId: string, sessionToken: string): Promise<Place> {
    const url = `${PLACES_URL}/places/${encodeURIComponent(placeId)}?sessionToken=${encodeURIComponent(sessionToken)}&languageCode=en`;
    const place = PlaceResponse.parse(
      await this.call(url, {
        method: 'GET',
        fieldMask: 'id,displayName,formattedAddress,location',
      }),
    );
    return {
      placeId: place.id,
      name: (place.displayName?.text ?? place.formattedAddress ?? 'Selected place').slice(0, 160),
      address: place.formattedAddress ?? null,
      point: { latitude: place.location.latitude, longitude: place.location.longitude },
    };
  }

  /**
   * Road route through the points in order. Returns null (never throws) when routing is off,
   * Google finds no route, or the call fails: trips must not depend on a provider being up.
   */
  async computeRoute(points: GeoPoint[], mode: 'RIDE' | 'TRAVEL'): Promise<ComputedRoute | null> {
    if (!this.enabled || points.length < 2) return null;
    const travelMode = mode === 'RIDE' ? 'TWO_WHEELER' : 'DRIVE';
    const waypoint = (p: GeoPoint) => ({ location: { latLng: p } });
    try {
      const body = await this.call(ROUTES_URL, {
        method: 'POST',
        fieldMask: 'routes.distanceMeters,routes.duration',
        body: {
          origin: waypoint(points[0]!),
          destination: waypoint(points.at(-1)!),
          intermediates: points.slice(1, -1).map(waypoint),
          travelMode,
          regionCode: 'IN',
          units: 'METRIC',
        },
      });
      const route = RoutesResponse.parse(body).routes[0];
      if (!route) return null;
      return {
        distanceMeters: route.distanceMeters,
        durationSeconds: Number.parseInt(route.duration, 10) || 0,
        travelMode,
      };
    } catch (error) {
      this.logger.warn(`Route computation failed: ${(error as Error).message}`);
      return null;
    }
  }

  private async call(
    url: string,
    options: { method: 'GET' | 'POST'; fieldMask: string | null; body?: unknown },
  ): Promise<unknown> {
    if (!this.enabled) throw new ServiceUnavailableException('Place search is not available yet');
    const headers: Record<string, string> = { 'X-Goog-Api-Key': this.config.GOOGLE_MAPS_API_KEY };
    if (options.fieldMask) headers['X-Goog-FieldMask'] = options.fieldMask;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(`Google Maps request failed: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Maps are temporarily unavailable');
    }
    if (!res.ok) {
      // The body can echo request details; log the status only.
      this.logger.warn(`Google Maps responded ${res.status}`);
      throw new ServiceUnavailableException('Maps are temporarily unavailable');
    }
    return res.json();
  }
}
