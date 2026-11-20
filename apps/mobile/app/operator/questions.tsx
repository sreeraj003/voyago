import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { type PackageQuestion } from '@voyago/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { answerQuestion, hideQuestion, listOperatorQuestions } from '../../src/api/commercial';
import { useFormError } from '../../src/auth/use-form-error';
import { Choice } from '../../src/components/Choice';
import { Button, FormMessage, TextField } from '../../src/components/Form';
import { FormScreen } from '../../src/components/FormScreen';
import { radius, spacing, typography } from '../../src/theme/tokens';
import { useTheme } from '../../src/theme/use-theme';

/** Questions customers asked about the business's packages. Answers are public. */
export default function OperatorQuestionsScreen() {
  const [filter, setFilter] = useState<'new' | 'all'>('new');
  const questions = useInfiniteQuery({
    queryKey: ['operator-questions', filter],
    queryFn: ({ pageParam }) => listOperatorQuestions(filter === 'new', pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.page.nextCursor ?? undefined,
  });
  const items = questions.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <FormScreen>
      <Choice
        label="Show"
        value={filter}
        options={[
          { value: 'new', label: 'Unanswered' },
          { value: 'all', label: 'All' },
        ]}
        onChange={setFilter}
      />
      <FormMessage tone="info">
        Answers appear on the package for everyone, without the asker's name. Never share phone
        numbers or move payments off Voyago in an answer.
      </FormMessage>
      {questions.isError ? (
        <FormMessage tone="error">Could not load questions. Try again shortly.</FormMessage>
      ) : null}
      {questions.isSuccess && items.length === 0 ? (
        <FormMessage tone="info">Nothing waiting for an answer.</FormMessage>
      ) : null}
      {items.map((q) => (
        <QuestionCard key={q.id} question={q} />
      ))}
      {questions.hasNextPage ? (
        <Button
          title="Show more"
          variant="secondary"
          loading={questions.isFetchingNextPage}
          onPress={() => void questions.fetchNextPage()}
        />
      ) : null}
    </FormScreen>
  );
}

function QuestionCard({ question }: { question: PackageQuestion }) {
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState(question.answer ?? '');
  const error = useFormError();
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ['operator-questions'] });
    void queryClient.invalidateQueries({ queryKey: ['operator-dashboard'] });
  };
  const send = useMutation({
    mutationFn: () => answerQuestion(question.id, answer.trim()),
    onMutate: () => error.clear(),
    onSuccess: done,
    onError: error.capture,
  });
  const hide = useMutation({ mutationFn: () => hideQuestion(question.id), onSuccess: done });
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.muted, { color: colors.textMuted }]}>
        {question.asker ? `${question.asker.displayName} (@${question.asker.username})` : 'Member'}{' '}
        · {new Date(question.createdAt).toLocaleDateString('en-IN')}
        {question.hidden ? ' · hidden' : ''}
      </Text>
      <Text style={[styles.body, { color: colors.text, fontWeight: '600' }]}>
        {question.question}
      </Text>
      {question.hidden ? null : (
        <>
          <TextField
            label={question.answer ? 'Your answer' : 'Answer'}
            value={answer}
            onChangeText={setAnswer}
            multiline
            maxLength={1000}
            error={error.fields.answer}
          />
          {error.message ? <FormMessage tone="error">{error.message}</FormMessage> : null}
          <View style={styles.row}>
            <Button
              title={question.answer ? 'Update answer' : 'Answer publicly'}
              loading={send.isPending}
              disabled={answer.trim().length === 0}
              onPress={() => send.mutate()}
            />
            <Button
              title="Hide (spam or abuse)"
              variant="link"
              loading={hide.isPending}
              onPress={() => hide.mutate()}
            />
          </View>
        </>
      )}
      <Button
        title="Open package"
        variant="link"
        onPress={() => router.push(`/packages/${question.packageId}`)}
      />
    </View>
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
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
});
