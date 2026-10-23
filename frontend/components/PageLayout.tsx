import type { ReactNode } from "react";
import { MotionGymLogo } from "./MotionGymLogo";
import { Header } from "./Header";
import { GymLoader } from "./GymLoader";

interface PageLayoutProps {
  children?: ReactNode;
  variant?: "centered" | "top";
  className?: string;
  action?: ReactNode;
  loading?: boolean;
}

export function PageLayout({ children, variant = "centered", className, action, loading }: PageLayoutProps) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <GymLoader className="flex flex-col items-center space-y-7 -mt-10" />
      </div>
    );
  }

  if (variant === "top") {
    return (
      <div className="flex flex-col flex-1">
        <Header action={action} />
        {children}
      </div>
    );
  }

  return (
    <div className={`flex-1 flex flex-col justify-center${className ? ` ${className}` : ""}`}>
      <div className="-mt-10">
        <MotionGymLogo className="w-[100px] h-[100px] sm:w-[150px] sm:h-[150px] mx-auto mb-8" />
        {children}
      </div>
    </div>
  );
}
