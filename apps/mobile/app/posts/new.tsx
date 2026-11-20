import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Image, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { uploadImage } from '../../src/api/maps-media';
import { createPost } from '../../src/api/social';
import { useFeatures } from '../../src/api/use-features';
import { useFormError } from '../../src/auth/use-form-error';
import { Choice } from '../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { PHOTOS_OFF_NOTE } from '../../src/components/CoverField';
import { FormScreen } from '../../src/components/FormScreen';
import { radius } from '../../src/theme/tokens';

type Audience = 'PUBLIC' | 'FOLLOWERS' | 'COMMUNITY';

/**
 * A trip recap (from a completed trip) or destination photos. Photos need Cloudinary to be
 * configured; without it only text recaps are possible.
 */
export default function NewPostScreen() {
  const params = useLocalSearchParams<{
    tripId?: string;
    tripTitle?: string;
    communityId?: string;
  }>();
  const features = useFeatures();
  const queryClient = useQueryClient();
  const error = useFormError();
  const isRecap = Boolean(params.tripId);
  const [body, setBody] = useState('');
  const [placeName, setPlaceName] = useState('');
  const [photos, setPhotos] = useState<{ id: string; uri: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [audience, setAudience] = useState<Audience>(params.communityId ? 'COMMUNITY' : 'PUBLIC');

  const pick = async () => {
    error.clear();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
      exif: false, // no GPS or camera data leaves the phone
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setUploading(true);
    try {
      const id = await uploadImage(asset, 'post-photo');
      setPhotos((current) => [...current, { id, uri: asset.uri }]);
    } catch (caught) {
      error.capture(caught);
    } finally {
      setUploading(false);
    }
  };

  const post = useMutation({
    mutationFn: () =>
      createPost({
        type: isRecap ? 'TRIP_RECAP' : 'PHOTO',
        ...(body.trim() ? { body: body.trim() } : {}),
        ...(photos.length > 0 ? { imageIds: photos.map((photo) => photo.id) } : {}),
        ...(placeName.trim() ? { placeName: placeName.trim() } : {}),
        ...(params.tripId ? { tripId: params.tripId } : {}),
        ...(params.communityId ? { communityId: params.communityId } : {}),
        visibility: audience,
      }),
    onMutate: () => error.clear(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feed'] });
      void queryClient.invalidateQueries({ queryKey: ['community-posts'] });
      router.back();
    },
    onError: (caught) => error.capture(caught),
  });

  return (
    <FormScreen>
      {isRecap ? (
        <FormMessage tone="info">Recap of {params.tripTitle ?? 'your trip'}</FormMessage>
      ) : null}
      <TextField
        label={isRecap ? 'How did it go?' : 'Caption (optional)'}
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={2000}
        error={error.fields.body}
      />
      <>
        {photos.map((photo, index) => (
          <Image
            key={photo.id}
            source={{ uri: photo.uri }}
            style={styles.photo}
            accessibilityLabel={`Photo ${index + 1}`}
          />
        ))}
        {photos.length < 6 ? (
          <Button
            title={photos.length ? 'Add another photo' : 'Add a photo'}
            variant="secondary"
            loading={uploading}
            disabled={!features.coverUploads}
            onPress={() => void pick()}
          />
        ) : null}
        {features.coverUploads ? null : <FormMessage tone="info">{PHOTOS_OFF_NOTE}</FormMessage>}
        <TextField
          label="Place (optional)"
          value={placeName}
          onChangeText={setPlaceName}
          maxLength={160}
          hint="A place name like Kudremukh. Photo locations are never read from your phone."
          error={error.fields.placeName}
        />
      </>
      <Choice
        label="Who can see it"
        value={audience}
        options={[
          { value: 'PUBLIC', label: 'Everyone' },
          { value: 'FOLLOWERS', label: 'Followers' },
          ...(params.communityId ? [{ value: 'COMMUNITY' as const, label: 'Community' }] : []),
        ]}
        onChange={setAudience}
      />
      {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
      <Button
        title="Post"
        loading={post.isPending}
        disabled={uploading || (!isRecap && photos.length === 0)}
        onPress={() => post.mutate()}
      />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.sm },
});
