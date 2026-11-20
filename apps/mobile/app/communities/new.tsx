import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { createCommunity } from '../../src/api/communities';
import { useFormError } from '../../src/auth/use-form-error';
import { CommunityForm } from '../../src/components/CommunityForm';
import { FormScreen } from '../../src/components/FormScreen';

export default function NewCommunityScreen() {
  const queryClient = useQueryClient();
  const error = useFormError();
  const create = useMutation({
    mutationFn: createCommunity,
    onMutate: () => error.clear(),
    onSuccess: (community) => {
      void queryClient.invalidateQueries({ queryKey: ['communities'] });
      router.replace(`/communities/${community.slug}`);
    },
    onError: (caught) => error.capture(caught),
  });
  return (
    <FormScreen>
      <CommunityForm
        submitTitle="Create community"
        busy={create.isPending}
        fields={error.fields}
        message={error.message}
        onSubmit={(values) => create.mutate({ ...values, slug: values.slug ?? '' })}
      />
    </FormScreen>
  );
}
