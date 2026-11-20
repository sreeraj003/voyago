import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { type UploadKind } from '@voyago/shared';
import { uploadImage } from '../api/maps-media';
import { radius, spacing, typography } from '../theme/tokens';
import { useTheme } from '../theme/use-theme';
import { Button } from './Form';

type Props = {
  previewUri: string | null;
  onUploaded: (imageId: string, previewUri: string) => void;
  onRemove: () => void;
  kind?: UploadKind;
};

/** Pick a cover photo and upload it to Cloudinary. Shown only when uploads are configured. */
export function CoverField({ previewUri, onUploaded, onRemove, kind = 'trip-cover' }: Props) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setError(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1200, 630],
      quality: 0.85,
      exif: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return;
    setBusy(true);
    try {
      onUploaded(await uploadImage(asset, kind), asset.uri);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.wrap}>
      <Text style={[styles.label, { color: colors.text }]}>Cover photo (optional)</Text>
      {previewUri ? (
        <Image
          source={{ uri: previewUri }}
          style={styles.preview}
          accessibilityLabel="Cover photo preview"
        />
      ) : null}
      <Button
        title={previewUri ? 'Change cover photo' : 'Add a cover photo'}
        variant="secondary"
        loading={busy}
        onPress={() => void pick()}
      />
      {previewUri ? <Button title="Remove cover photo" variant="link" onPress={onRemove} /> : null}
      {error ? <Text style={[styles.caption, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  label: { ...typography.caption, fontWeight: '600' },
  caption: { ...typography.caption },
  preview: { width: '100%', aspectRatio: 1200 / 630, borderRadius: radius.md },
});
