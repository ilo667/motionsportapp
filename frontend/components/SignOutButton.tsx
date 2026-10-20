"use client";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api";

export function SignOutButton() {
  const pathname = usePathname();
  const router = useRouter();

  if (pathname !== "/report") return null;

  async function handleLogout() {
    await api.logout().catch(() => {});
    router.push("/");
  }

  return (
    <button
      onClick={handleLogout}
      className="flex items-center space-x-1.5 font-medium text-base leading-relaxed text-body transition-colors cursor-pointer"
    >
      <Image src="/sign-out.svg" alt="" width={20} height={20} aria-hidden className="w-4 h-4 sm:w-5 sm:h-5 mr-[5px]" />
      Sign out
    </button>
  );
}
