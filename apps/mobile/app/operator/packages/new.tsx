import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useState } from 'react';
import { createPackage } from '../../../src/api/commercial';
import { ApiRequestError } from '../../../src/api/http';
import { emptyPackageForm, formErrors, toPackageInput } from '../../../src/commercial/package-form';
import { Button, FormMessage } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { PackageFormView } from '../../../src/components/PackageFormView';

export default function NewPackageScreen() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(emptyPackageForm);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: createPackage,
    onSuccess: (pkg) => {
      void queryClient.invalidateQueries({ queryKey: ['my-packages'] });
      void queryClient.invalidateQueries({ queryKey: ['operator-dashboard'] });
      router.replace(`/operator/packages/${pkg.id}`);
    },
    onError: (caught) => {
      if (caught instanceof ApiRequestError) {
        setErrors(formErrors(caught.fieldErrors));
        setMessage(caught.message);
      } else setMessage('Could not reach Voyago. Check your connection and try again.');
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
    save.mutate(result.input);
  };
  return (
    <FormScreen>
      <FormMessage tone="info">
        Saved as a draft. You can publish it once your business is verified.
      </FormMessage>
      <PackageFormView
        form={form}
        onChange={setForm}
        errors={errors}
        previews={previews}
        onPreview={(id, uri) => setPreviews((p) => ({ ...p, [id]: uri }))}
      />
      {message ? <FormMessage tone="error">{message}</FormMessage> : null}
      <Button title="Save draft" loading={save.isPending} onPress={submit} />
    </FormScreen>
  );
}
