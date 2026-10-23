import { MyPurchasesPage } from "@/components/MyPurchasesPage";
import type { AssignedType } from "@/lib/api";

const TYPES: AssignedType[] = ["персональні", "спліт"];

// ?type=персональні|спліт: opened from «Оплатити» on a training card, the purchase flow starts with that type
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { type } = await searchParams;
  const startType = TYPES.find((t) => t === type);
  return <MyPurchasesPage startType={startType} />;
}
