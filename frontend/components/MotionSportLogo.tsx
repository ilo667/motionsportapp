import Image from "next/image";
import Link from "next/link";

export function MotionSportLogo({ className = "w-[150px] h-[150px]" }: { white?: boolean; className?: string }) {
  return (
    <Link href="/">
      <Image
        src="/motion-sport-logo.png"
        alt="Motion Sport"
        width={150}
        height={150}
        quality={100}
        priority
        className={className}
      />
    </Link>
  );
}