import type { ReactNode } from "react";
import { MotionGymLogo } from "./MotionGymLogo";

export function Header({ action }: { action?: ReactNode }) {
  return (
    <header className="flex items-center justify-between py-3 mb-4">
      <MotionGymLogo className="w-[60px] h-[60px]" />
      {action}
    </header>
  );
}
