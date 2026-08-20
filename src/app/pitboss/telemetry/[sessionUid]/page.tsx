import TelemetryDashboard from "@/components/pitboss/TelemetryDashboard";

export default function TelemetrySessionPage({
  params,
}: {
  params: { sessionUid: string };
}) {
  return <TelemetryDashboard sessionUid={decodeURIComponent(params.sessionUid)} />;
}
