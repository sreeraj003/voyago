import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type Trip } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { getTrip, updateTrip } from '../../../src/api/trips';
import { useFormError } from '../../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { TripFormWizard } from '../../../src/components/TripFormWizard';
import { changedFields, fromTrip, toTripInput } from '../../../src/trips/trip-form';

export default function EditTripScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const trip = useQuery({ queryKey: ['trip', id], queryFn: () => getTrip(id) });
  if (!trip.data) {
    return (
      <FormScreen>
        <FormMessage tone={trip.isError ? 'error' : 'info'}>
          {trip.isError ? 'Could not load this trip.' : 'Loading…'}
        </FormMessage>
      </FormScreen>
    );
  }
  return hasStarted(trip.data) ? (
    <DescriptionOnly trip={trip.data} />
  ) : (
    <FullEdit trip={trip.data} />
  );
}

/** Mirrors the API: a trip counts as started once it is under way or its departure has passed. */
function hasStarted(trip: Trip): boolean {
  return trip.status === 'IN_PROGRESS' || new Date(trip.departureAt).getTime() <= Date.now();
}

function useSave(id: string) {
  const queryClient = useQueryClient();
  const error = useFormError();
  const save = useMutation({
    mutationFn: (input: Parameters<typeof updateTrip>[1]) => updateTrip(id, input),
    onMutate: () => error.clear(),
    onSuccess: (updated) => {
      queryClient.setQueryData(['trip', id], updated);
      void queryClient.invalidateQueries({ queryKey: ['my-trips'] });
      router.back();
    },
    onError: (caught) => error.capture(caught),
  });
  return { save, error };
}

function FullEdit({ trip }: { trip: Trip }) {
  const { save, error } = useSave(trip.id);
  const initial = fromTrip(trip);
  const original = toTripInput(initial);
  return (
    <FormScreen>
      <TripFormWizard
        initial={initial}
        previewNote="Only the fields you changed are saved."
        submitLabel="Save changes"
        busy={save.isPending}
        serverError={error.message}
        serverFields={error.fields}
        onSubmit={(input) => {
          const changes = original.ok ? changedFields(original.input, input) : input;
          if (Object.keys(changes).length === 0) router.back();
          else save.mutate(changes);
        }}
      />
    </FormScreen>
  );
}

/** After the trip starts, only the description can change (enforced by the API). */
function DescriptionOnly({ trip }: { trip: Trip }) {
  const { save, error } = useSave(trip.id);
  const [description, setDescription] = useState(trip.description ?? '');
  return (
    <FormScreen>
      <FormMessage tone="info">
        The trip has started, so only the description can change.
      </FormMessage>
      <TextField
        label="Description"
        value={description}
        onChangeText={setDescription}
        multiline
        error={error.fields.description}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button
        title="Save"
        loading={save.isPending}
        onPress={() => save.mutate({ description: description.trim() || null })}
      />
    </FormScreen>
  );
}
