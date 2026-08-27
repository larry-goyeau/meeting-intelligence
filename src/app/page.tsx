import { Workspace } from "@/components/Workspace";
import { getSystemStatus } from "@/lib/status";

// The corpus lives in a local database, so this page cannot be statically
// rendered; it also must not be cached, or a freshly ingested meeting would not
// appear until a restart.
export const dynamic = "force-dynamic";

export default async function Page() {
  // Read on the server so the first paint already shows the corpus. The client
  // refetches only after it changes something.
  const { status, meetings } = getSystemStatus();
  return <Workspace initialStatus={status} initialMeetings={meetings} />;
}
