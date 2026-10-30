import { TrainerJoinForm } from "./TrainerJoinForm";

// Invite link: /admin/join?t=<token>
export default async function TrainerJoinPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { t } = await searchParams;
  return <TrainerJoinForm token={typeof t === "string" ? t : ""} />;
}
