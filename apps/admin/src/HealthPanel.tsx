import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from './api';

export function HealthPanel() {
  const { data, error, isPending } = useQuery({
    queryKey: ['health'],
    queryFn: () => fetchHealth(),
    refetchInterval: 15_000,
  });

  if (isPending) return <p role="status">Checking API…</p>;
  if (error) {
    return (
      <p role="alert" className="status status--down">
        API unreachable: {error.message}
      </p>
    );
  }

  return (
    <section aria-labelledby="health-heading" className="card">
      <h2 id="health-heading">
        API status: <span className={`status status--${data.status}`}>{data.status}</span>
      </h2>
      <dl className="checks">
        {Object.entries(data.checks).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd className={`status status--${value}`}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="muted">Version {data.version}</p>
    </section>
  );
}
