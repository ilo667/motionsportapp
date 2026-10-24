import { TrainerJoinForm } from "@/components/admin/TrainerJoinForm";

// The page an invite link opens: /admin/join?t=<token>
export default async function TrainerJoinPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { t } = await searchParams;
  return <TrainerJoinForm token={typeof t === "string" ? t : ""} />;
}
