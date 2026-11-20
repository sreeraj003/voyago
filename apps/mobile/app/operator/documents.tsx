import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_OPERATOR_DOCUMENTS, type MyOperator, type OwnOperatorDocument } from '@voyago/shared';
import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  addOperatorDocument,
  getMyOperator,
  myOperatorKey,
  removeOperatorDocument,
} from '../../src/api/commercial';
import { uploadImage } from '../../src/api/maps-media';
import { useFeatures } from '../../src/api/use-features';
import { useFormError } from '../../src/auth/use-form-error';
import { Choice } from '../../src/components/Choice';
import { Button, FormMessage } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

type Kind = OwnOperatorDocument['kind'];

const KIND_OPTIONS: readonly { value: Kind; label: string }[] = [
  { value: 'BUSINESS_REGISTRATION', label: 'Business registration' },
  { value: 'GST_CERTIFICATE', label: 'GST certificate' },
  { value: 'OWNER_ID', label: "Owner's ID" },
  { value: 'TOURISM_LICENCE', label: 'Tourism licence' },
  { value: 'INSURANCE', label: 'Insurance' },
  { value: 'OTHER', label: 'Other' },
];
const kindLabel = (kind: Kind) => KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
const STATUS: Record<OwnOperatorDocument['status'], string> = {
  PENDING: 'Waiting for review',
  ACCEPTED: 'Accepted',
  REJECTED: 'Not accepted',
};

/** Upload the papers Voyago's team checks before verifying the business. */
export default function OperatorDocumentsScreen() {
  const operator = useQuery({ queryKey: myOperatorKey, queryFn: getMyOperator });
  if (operator.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (!operator.data) {
    return (
      <FormScreen>
        <FormMessage tone="error">Set up your business profile first.</FormMessage>
      </FormScreen>
    );
  }
  return <Documents operator={operator.data} />;
}

function Documents({ operator }: { operator: MyOperator }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const features = useFeatures();
  const [kind, setKind] = useState<Kind>('BUSINESS_REGISTRATION');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const error = useFormError();
  const onSaved = (next: MyOperator) => queryClient.setQueryData(myOperatorKey, next);

  const add = useMutation({
    mutationFn: async () => {
      setUploadError(null);
      const picked = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'image/jpeg', 'image/png'],
        copyToCacheDirectory: true,
      });
      const file = picked.canceled ? undefined : picked.assets[0];
      if (!file) return null;
      setUploading(true);
      try {
        const documentId = await uploadImage(
          { uri: file.uri, mimeType: file.mimeType, fileSize: file.size, name: file.name },
          'operator-document',
        );
        return await addOperatorDocument({ kind, documentId, fileName: file.name.slice(0, 200) });
      } finally {
        setUploading(false);
      }
    },
    onMutate: () => error.clear(),
    onSuccess: (next) => {
      if (next) onSaved(next);
    },
    onError: (caught) => {
      if (caught instanceof Error && caught.name !== 'ApiRequestError') {
        setUploadError(caught.message);
      } else error.capture(caught);
    },
  });
  const remove = useMutation({ mutationFn: removeOperatorDocument, onSuccess: onSaved });
  const full = operator.documents.length >= MAX_OPERATOR_DOCUMENTS;

  return (
    <FormScreen>
      <FormMessage tone="info">
        Add a PDF, JPG or PNG (up to 10 MB each) of your registration, GST certificate, licences or
        ID. Files are private: only Voyago's verification team can open them, and each opening is
        recorded. Uploading alone does not verify you; a person reviews every document.
      </FormMessage>
      {operator.documents.map((doc) => (
        <View
          key={doc.id}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.body, { color: colors.text, fontWeight: '600' }]}>
            {kindLabel(doc.kind)}
          </Text>
          <Text style={[styles.muted, { color: colors.textMuted }]}>{doc.fileName}</Text>
          <Text
            style={[
              styles.muted,
              {
                color:
                  doc.status === 'ACCEPTED'
                    ? colors.success
                    : doc.status === 'REJECTED'
                      ? colors.danger
                      : colors.textMuted,
              },
            ]}
          >
            {STATUS[doc.status]}
            {doc.reviewNote ? `: ${doc.reviewNote}` : ''}
          </Text>
          {doc.status !== 'ACCEPTED' ? (
            <Button
              title="Remove"
              variant="link"
              loading={remove.isPending && remove.variables === doc.id}
              onPress={() => remove.mutate(doc.id)}
            />
          ) : null}
        </View>
      ))}
      {!features.coverUploads ? (
        <FormMessage tone="info">
          Document uploads switch on once file storage (Cloudinary) is set up on the server.
        </FormMessage>
      ) : full ? (
        <FormMessage tone="info">Remove a document to add another.</FormMessage>
      ) : (
        <>
          <Choice label="Document type" value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <Button
            title={uploading ? 'Uploading…' : 'Choose file and upload'}
            loading={add.isPending}
            onPress={() => add.mutate()}
          />
        </>
      )}
      {uploadError ? <FormMessage tone="error">{uploadError}</FormMessage> : null}
      {error.message ? (
        <FormMessage tone="error">{error.fields.documentId ?? error.message}</FormMessage>
      ) : null}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  body: { ...typography.body },
  muted: { ...typography.caption },
});
