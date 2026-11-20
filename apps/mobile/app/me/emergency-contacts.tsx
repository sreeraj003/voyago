import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_EMERGENCY_CONTACTS } from '@voyago/shared';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { addContact, listContacts, removeContact } from '../../src/api/safety';
import { useFormError } from '../../src/auth/use-form-error';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

const KEY = ['emergency-contacts'];

export default function EmergencyContactsScreen() {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const contacts = useQuery({ queryKey: KEY, queryFn: listContacts });
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const { message, fields, capture, clear } = useFormError();
  const add = useMutation({
    mutationFn: () => addContact({ name, phone, relationship: relationship.trim() || undefined }),
    onSuccess: () => {
      clear();
      setName('');
      setPhone('');
      setRelationship('');
      void queryClient.invalidateQueries({ queryKey: KEY });
    },
    onError: capture,
  });
  const remove = useMutation({
    mutationFn: removeContact,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });
  const full = (contacts.data?.length ?? 0) >= MAX_EMERGENCY_CONTACTS;

  return (
    <FormScreen>
      <FormMessage tone="info">
        Up to {MAX_EMERGENCY_CONTACTS} people we text if you raise an SOS on a trip, with the trip
        and your last known location. Nobody else sees these numbers. Tell them you added them.
      </FormMessage>
      {contacts.isError ? (
        <FormMessage tone="error">Could not load your emergency contacts.</FormMessage>
      ) : null}
      {contacts.data?.map((contact) => (
        <View
          key={contact.id}
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.name, { color: colors.text }]}>
            {contact.name}
            {contact.relationship ? ` (${contact.relationship})` : ''}
          </Text>
          <Text style={[styles.caption, { color: colors.textMuted }]}>{contact.phone}</Text>
          <Button
            title="Remove"
            variant="link"
            loading={remove.isPending && remove.variables === contact.id}
            onPress={() => remove.mutate(contact.id)}
          />
        </View>
      ))}
      {full ? (
        <FormMessage tone="info">Remove a contact to add someone else.</FormMessage>
      ) : (
        <>
          <TextField label="Name" value={name} onChangeText={setName} error={fields.name} />
          <TextField
            label="Mobile number"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            placeholder="+91 98450 12345"
            error={fields.phone}
          />
          <TextField
            label="Relationship (optional)"
            value={relationship}
            onChangeText={setRelationship}
            error={fields.relationship}
          />
          {message ? <FormMessage tone="error">{message}</FormMessage> : null}
          <Button title="Add contact" loading={add.isPending} onPress={() => add.mutate()} />
        </>
      )}
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
  name: { ...typography.body, fontWeight: '600' },
  caption: { ...typography.caption },
});
