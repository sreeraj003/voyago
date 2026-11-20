import { type Community, type CreateCommunityInput } from '@voyago/shared';
import { useState } from 'react';
import { useFeatures } from '../api/use-features';
import { slugify } from '../communities/slug';
import { COMMUNITY_CATEGORY_OPTIONS } from '../trips/labels';
import { Choice } from './Choice';
import { CoverField } from './CoverField';
import { Button, FormMessage, TextField } from './Form';

type Category = (typeof COMMUNITY_CATEGORY_OPTIONS)[number]['value'];
type ModeChoice = 'BOTH' | 'RIDE' | 'TRAVEL';
export type CommunityFormValues = Omit<CreateCommunityInput, 'slug'> & { slug?: string };

/** Create and edit form. The address (slug) is fixed after creation. */
export function CommunityForm({
  initial,
  submitTitle,
  busy,
  fields,
  message,
  onSubmit,
}: {
  initial?: Community;
  submitTitle: string;
  busy: boolean;
  fields: Record<string, string | undefined>;
  message: string | null;
  onSubmit: (values: CommunityFormValues) => void;
}) {
  const features = useFeatures();
  const [name, setName] = useState(initial?.name ?? '');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState<Category>(initial?.category ?? 'RIDING_CLUB');
  const [mode, setMode] = useState<ModeChoice>(initial?.mode ?? 'BOTH');
  const [city, setCity] = useState(initial?.city ?? 'Bengaluru');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'PRIVATE'>(
    initial?.visibility ?? 'PUBLIC',
  );
  const [joinPolicy, setJoinPolicy] = useState<'OPEN' | 'APPROVAL'>(initial?.joinPolicy ?? 'OPEN');
  const [cover, setCover] = useState<{ id: string | null; preview: string | null } | undefined>(
    undefined,
  );
  const shownSlug = slugTouched ? slug : slugify(name);
  const previewUri = cover ? cover.preview : (initial?.coverImageUrl ?? null);

  const submit = () =>
    onSubmit({
      name,
      ...(initial ? {} : { slug: shownSlug }),
      description: description.trim() || null,
      category,
      mode: mode === 'BOTH' ? null : mode,
      city: city.trim() || null,
      visibility,
      joinPolicy: visibility === 'PRIVATE' ? 'APPROVAL' : joinPolicy,
      ...(cover ? { coverImageId: cover.id } : {}),
    });

  return (
    <>
      <TextField
        label="Name"
        value={name}
        onChangeText={setName}
        maxLength={100}
        error={fields.name}
      />
      {initial ? null : (
        <TextField
          label="Address"
          value={shownSlug}
          onChangeText={(value) => {
            setSlugTouched(true);
            setSlug(value.toLowerCase());
          }}
          autoCapitalize="none"
          autoCorrect={false}
          hint={`voyago.app/c/${shownSlug || 'your-community'}. Lowercase letters, numbers and hyphens.`}
          error={fields.slug}
        />
      )}
      <TextField
        label="About (optional)"
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={2000}
        error={fields.description}
      />
      <Choice
        label="Kind of group"
        value={category}
        options={COMMUNITY_CATEGORY_OPTIONS}
        onChange={setCategory}
      />
      <Choice
        label="For"
        value={mode}
        options={[
          { value: 'BOTH', label: 'Rides and travel' },
          { value: 'RIDE', label: 'Rides' },
          { value: 'TRAVEL', label: 'Travel' },
        ]}
        onChange={setMode}
      />
      <TextField
        label="City (optional)"
        value={city}
        onChangeText={setCity}
        maxLength={80}
        hint="City only. Never a home address."
        error={fields.city}
      />
      <Choice
        label="Who can see posts, trips and members"
        value={visibility}
        options={[
          { value: 'PUBLIC', label: 'Everyone' },
          { value: 'PRIVATE', label: 'Members only' },
        ]}
        onChange={setVisibility}
      />
      {visibility === 'PUBLIC' ? (
        <Choice
          label="Joining"
          value={joinPolicy}
          options={[
            { value: 'OPEN', label: 'Anyone can join' },
            { value: 'APPROVAL', label: 'Moderators approve' },
          ]}
          onChange={setJoinPolicy}
        />
      ) : (
        <FormMessage tone="info">
          Private communities show only their name and description to others. Moderators approve
          every member.
        </FormMessage>
      )}
      {features.coverUploads ? (
        <CoverField
          kind="community-cover"
          previewUri={previewUri}
          onUploaded={(id, preview) => setCover({ id, preview })}
          onRemove={() => setCover({ id: null, preview: null })}
        />
      ) : null}
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      <Button title={submitTitle} loading={busy} onPress={submit} />
    </>
  );
}
