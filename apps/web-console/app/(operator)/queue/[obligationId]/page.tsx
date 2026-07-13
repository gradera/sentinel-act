import { ItemDetailClient } from "./item-detail-client";

// Server component wrapper only — Next.js 15 hands Server Components an
// async `params` (a Promise); unwrapping it here keeps the actual detail
// view (`item-detail-client.tsx`) a plain client component that takes
// `obligationId` as an ordinary prop, rather than every child needing
// `React.use()` to read route params.
export default async function ObligationDetailPage({ params }: { params: Promise<{ obligationId: string }> }) {
  const { obligationId } = await params;
  return <ItemDetailClient obligationId={obligationId} />;
}
