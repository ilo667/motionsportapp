import { MotionGymLogo } from "./MotionGymLogo";
import { Header } from "./Header";

interface PageLayoutProps {
  children: React.ReactNode;
  variant?: "centered" | "top";
  className?: string;
  action?: React.ReactNode;
}

export function PageLayout({ children, variant = "centered", className, action }: PageLayoutProps) {
  if (variant === "top") {
    return (
      <div className="flex flex-col">
        <Header action={action} />
        {children}
      </div>
    );
  }

  return (
    <div className={`flex-1 flex flex-col justify-center pb-[20vh]${className ? ` ${className}` : ""}`}>
      <MotionGymLogo className="w-[100px] h-[100px] mx-auto mb-8" />
      {children}
    </div>
  );
}