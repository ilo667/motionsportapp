import { PaymentResult } from "./PaymentResult";

export default async function PaymentReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { order } = await searchParams;
  return <PaymentResult orderId={typeof order === "string" ? order : undefined} />;
}
