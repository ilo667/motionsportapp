import type { TrainingType } from "./api";

// Colors of training types (calendar events, legend, history chips). Applied as inline styles
export const TYPE_COLORS: Record<TrainingType, { bg: string; border: string; text: string }> = {
  групові: { bg: "#14532d", border: "#93d23c", text: "#bbf7d0" },
  персональні: { bg: "#3b2f00", border: "#eab308", text: "#fef08a" },
  спліт: { bg: "#7c2d12", border: "#fb923c", text: "#fed7aa" },
};
