"use client";

import { usePathname } from "next/navigation";
import { MotionGymLogo } from "./MotionGymLogo";
import { SignOutButton } from "./SignOutButton";

export function Header() {
  const pathname = usePathname();
  const mobilePadding = pathname === "/report" ? "p-[8px]" : "p-[19px]";
  return (
    <header className={`${mobilePadding} sm:px-[70px] sm:py-[27px] flex items-center justify-between`}>
      <MotionGymLogo />
      <SignOutButton />
    </header>
  );
}
