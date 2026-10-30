import { MyPurchasesPage } from "./MyPurchasesPage";
import type { AssignedType } from "@/lib/api";

const TYPES: AssignedType[] = ["personal", "split"];

// ?type=personal|split starts the purchase flow with that type
export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { type } = await searchParams;
  const startType = TYPES.find((t) => t === type);
  return <MyPurchasesPage startType={startType} />;
}
