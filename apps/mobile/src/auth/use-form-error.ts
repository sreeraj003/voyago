import { useState } from 'react';
import { ApiRequestError } from '../api/http';

/** Splits an API failure into a form-level message and per-field messages. */
export function useFormError() {
  const [message, setMessage] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  return {
    message,
    fields,
    clear: () => {
      setMessage(null);
      setFields({});
    },
    capture: (error: unknown) => {
      if (error instanceof ApiRequestError) {
        setFields(error.fieldErrors);
        setMessage(
          Object.keys(error.fieldErrors).length > 0
            ? 'Please check the highlighted fields.'
            : error.message,
        );
      } else {
        setFields({});
        setMessage('Could not reach Voyago. Check your connection and try again.');
      }
    },
  };
}
