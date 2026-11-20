import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { createTrip } from '../../src/api/trips';
import { useFormError } from '../../src/auth/use-form-error';
import { FormScreen } from '../../src/components/FormScreen';
import { TripFormWizard } from '../../src/components/TripFormWizard';
import { useModeStore } from '../../src/store/mode-store';
import { emptyTripForm } from '../../src/trips/trip-form';

export default function NewTripScreen() {
  const mode = useModeStore((state) => state.mode);
  const queryClient = useQueryClient();
  const error = useFormError();
  const save = useMutation({
    mutationFn: createTrip,
    onMutate: () => error.clear(),
    onSuccess: (trip) => {
      void queryClient.invalidateQueries({ queryKey: ['my-trips'] });
      router.replace(`/trips/${trip.id}`);
    },
    onError: (caught) => error.capture(caught),
  });

  return (
    <FormScreen>
      <TripFormWizard
        initial={emptyTripForm(mode)}
        previewNote="Saved as a draft. Publish it when you're ready for people to join."
        submitLabel="Save draft"
        busy={save.isPending}
        serverError={error.message}
        serverFields={error.fields}
        onSubmit={(input) => save.mutate(input)}
      />
    </FormScreen>
  );
}
