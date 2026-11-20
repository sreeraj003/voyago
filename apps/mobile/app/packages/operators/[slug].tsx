import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { getOperatorProfile } from '../../../src/api/commercial';
import { categoryLabel } from '../../../src/commercial/package-form';
import { FormMessage } from '../../../src/components/Form';
import { FormScreen } from '../../../src/components/FormScreen';
import { PackageCardView } from '../../../src/components/PackageCardView';
import { spacing, typography } from '../../../src/theme/tokens';
import { useTheme } from '../../../src/theme/use-theme';

/** A business's public page: what Voyago checked, and its experiences on sale. */
export default function OperatorProfileScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { colors } = useTheme();
  const operator = useQuery({
    queryKey: ['operator', slug],
    queryFn: () => getOperatorProfile(slug),
  });
  const data = operator.data;
  return (
    <FormScreen>
      {operator.isPending ? <FormMessage tone="info">Loading…</FormMessage> : null}
      {operator.isError ? (
        <FormMessage tone="error">This business is not available.</FormMessage>
      ) : null}
      {data ? (
        <>
          <View style={styles.head}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
              {data.displayName}
            </Text>
            <Text style={[styles.muted, { color: colors.textMuted }]}>
              {categoryLabel(data.category)}
              {data.city ? ` · ${data.city}, ${data.state ?? ''}` : ''}
            </Text>
            <Text
              style={[styles.muted, { color: data.verified ? colors.success : colors.textMuted }]}
            >
              {data.verified
                ? `✓ Business verified by Voyago${data.verifiedSince ? ` since ${new Date(data.verifiedSince).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}` : ''}`
                : 'Not verified yet'}
            </Text>
            {data.website ? (
              <Text style={[styles.muted, { color: colors.textMuted }]}>{data.website}</Text>
            ) : null}
          </View>
          {data.description ? (
            <Text style={[styles.body, { color: colors.text }]}>{data.description}</Text>
          ) : null}
          <Text style={[styles.heading, { color: colors.text }]}>Experiences</Text>
          {data.packages.length === 0 ? (
            <FormMessage tone="info">Nothing on sale right now.</FormMessage>
          ) : null}
          {data.packages.map((pkg) => (
            <PackageCardView key={pkg.id} pkg={pkg} />
          ))}
        </>
      ) : null}
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  head: { gap: spacing.xs },
  title: { ...typography.title },
  heading: { ...typography.heading },
  body: { ...typography.body },
  muted: { ...typography.caption },
});
