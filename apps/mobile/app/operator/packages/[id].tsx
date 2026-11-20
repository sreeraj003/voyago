import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatPaise, type OwnPackage } from '@voyago/shared';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { getMyPackage, packageAction, updatePackage } from '../../../src/api/commercial';
import { ApiRequestError } from '../../../src/api/http';
import {
  formErrors,
  fromOwnPackage,
  PACKAGE_STATUS_LABELS,
  packageDates,
  toPackageInput,
} from '../../../src/commercial/package-form';
import { Button, FormMessage } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { PackageFormView } from '../../../src/components/PackageFormView';
import { radius, spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

export default function OwnPackageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const pkg = useQuery({ queryKey: ['my-package', id], queryFn: () => getMyPackage(id) });
  if (pkg.isPending) {
    return (
      <FormScreen>
        <FormMessage tone="info">Loading…</FormMessage>
      </FormScreen>
    );
  }
  if (!pkg.data) {
    return (
      <FormScreen>
        <FormMessage tone="error">Package not found.</FormMessage>
      </FormScreen>
    );
  }
  return <Manage pkg={pkg.data} />;
}

const errorText = (caught: unknown) =>
  caught instanceof ApiRequestError
    ? caught.message
    : 'Could not reach Voyago. Check your connection and try again.';

function Manage({ pkg }: { pkg: OwnPackage }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = (next: OwnPackage) => {
    queryClient.setQueryData(['my-package', next.id], next);
    void queryClient.invalidateQueries({ queryKey: ['my-packages'] });
    void queryClient.invalidateQueries({ queryKey: ['operator-dashboard'] });
  };
  const act = useMutation({
    mutationFn: (action: 'publish' | 'unpublish' | 'archive') => packageAction(pkg.id, action),
    onMutate: () => setMessage(null),
    onSuccess: refresh,
    onError: (caught) => setMessage(errorText(caught)),
  });
  const card = [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }];

  if (editing) {
    return (
      <EditPackage
        pkg={pkg}
        onDone={(next) => {
          if (next) refresh(next);
          setEditing(false);
        }}
      />
    );
  }
  return (
    <FormScreen>
      <View style={card}>
        <Text style={[styles.heading, { color: colors.text }]}>{pkg.title}</Text>
        <Text
          style={[
            styles.status,
            {
              color:
                pkg.status === 'PUBLISHED'
                  ? colors.success
                  : pkg.status === 'SUSPENDED'
                    ? colors.danger
                    : colors.textMuted,
            },
          ]}
        >
          {PACKAGE_STATUS_LABELS[pkg.status]}
        </Text>
        {pkg.suspendedReason ? (
          <Text style={[styles.body, { color: colors.text }]}>
            Reason from Voyago: {pkg.suspendedReason}
          </Text>
        ) : null}
        <Text style={[styles.body, { color: colors.text }]}>
          {formatPaise(pkg.pricePaise)} per person · {pkg.capacity} places · {pkg.seatsLeft} left
        </Text>
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          {packageDates(pkg.startsAt, pkg.endsAt)}
        </Text>
        <Text style={[styles.muted, { color: colors.textMuted }]}>
          {pkg.viewCount} views · {pkg.questions.total} questions ({pkg.questions.unanswered}{' '}
          unanswered)
        </Text>
      </View>

      {pkg.publishIssues.length > 0 && pkg.status === 'DRAFT' ? (
        <View style={card}>
          <Text style={[styles.body, { color: colors.text, fontWeight: '600' }]}>
            Before publishing
          </Text>
          {pkg.publishIssues.map((issue) => (
            <Text key={issue} style={[styles.body, { color: colors.text }]}>
              • {issue}
            </Text>
          ))}
        </View>
      ) : null}

      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      {pkg.actions.includes('publish') ? (
        <Button title="Publish" loading={act.isPending} onPress={() => act.mutate('publish')} />
      ) : null}
      {pkg.actions.includes('edit') ? (
        <Button title="Edit" variant="secondary" onPress={() => setEditing(true)} />
      ) : null}
      {pkg.actions.includes('unpublish') ? (
        <>
          <Button
            title="Unpublish to edit"
            variant="secondary"
            loading={act.isPending}
            onPress={() => act.mutate('unpublish')}
          />
          <Text style={[styles.muted, { color: colors.textMuted }]}>
            Published packages can't be changed while on sale, so customers always see the terms
            they agreed to.
          </Text>
        </>
      ) : null}
      <Button
        title="See it as customers do"
        variant="link"
        onPress={() => router.push(`/packages/${pkg.id}`)}
      />
      {pkg.actions.includes('archive') ? (
        <Button
          title="Archive (take off sale for good)"
          variant="link"
          onPress={() => act.mutate('archive')}
        />
      ) : null}
    </FormScreen>
  );
}

function EditPackage({ pkg, onDone }: { pkg: OwnPackage; onDone: (next?: OwnPackage) => void }) {
  const [form, setForm] = useState(() => fromOwnPackage(pkg));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>(() =>
    Object.fromEntries(pkg.photoIds.map((id, i) => [id, pkg.imageUrls[i] ?? ''])),
  );
  const save = useMutation({
    mutationFn: (input: Parameters<typeof updatePackage>[1]) => updatePackage(pkg.id, input),
    onSuccess: (next) => onDone(next),
    onError: (caught) => {
      if (caught instanceof ApiRequestError) setErrors(formErrors(caught.fieldErrors));
      setMessage(errorText(caught));
    },
  });
  const submit = () => {
    setMessage(null);
    const result = toPackageInput(form);
    if (!result.ok) {
      setErrors(result.errors);
      setMessage('Please check the highlighted fields.');
      return;
    }
    setErrors({});
    save.mutate({ ...result.input, description: result.input.description ?? null });
  };
  return (
    <FormScreen>
      <PackageFormView
        form={form}
        onChange={setForm}
        errors={errors}
        previews={previews}
        onPreview={(id, uri) => setPreviews((p) => ({ ...p, [id]: uri }))}
      />
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      <Button title="Save changes" loading={save.isPending} onPress={submit} />
      <Button title="Cancel" variant="link" onPress={() => onDone()} />
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
  heading: { ...typography.heading },
  status: { ...typography.body, fontWeight: '700' },
  body: { ...typography.body },
  muted: { ...typography.caption },
});
