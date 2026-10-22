import Image from "next/image";
import Link from "next/link";

export function MotionGymLogo({ className = "w-[120px] h-[120px] sm:w-[150px] sm:h-[150px]" }: { className?: string }) {
  return (
    <Link href="/">
      <Image
        src="/motion-gym-logo.png"
        alt="Motion Gym"
        width={150}
        height={150}
        quality={100}
        priority
        className={className}
      />
    </Link>
  );
}