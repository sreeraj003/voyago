import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { getCommunity, updateCommunity } from '../../../src/api/communities';
import { useFormError } from '../../../src/auth/use-form-error';
import { CommunityForm } from '../../../src/components/CommunityForm';
import { FormMessage } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';

export default function EditCommunityScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const queryClient = useQueryClient();
  const community = useQuery({ queryKey: ['community', slug], queryFn: () => getCommunity(slug) });
  const error = useFormError();
  const save = useMutation({
    mutationFn: (values: Parameters<typeof updateCommunity>[1]) => updateCommunity(slug, values),
    onMutate: () => error.clear(),
    onSuccess: (updated) => {
      queryClient.setQueryData(['community', slug], updated);
      void queryClient.invalidateQueries({ queryKey: ['communities'] });
      router.back();
    },
    onError: (caught) => error.capture(caught),
  });
  return (
    <FormScreen>
      {community.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {community.data && !community.data.viewer.actions.includes('edit') ? (
        <FormMessage tone="error">Only admins can edit this community.</FormMessage>
      ) : null}
      {community.data?.viewer.actions.includes('edit') ? (
        <CommunityForm
          initial={community.data}
          submitTitle="Save changes"
          busy={save.isPending}
          fields={error.fields}
          message={error.message}
          onSubmit={({ slug: _slug, ...values }) => save.mutate(values)}
        />
      ) : null}
    </FormScreen>
  );
}
