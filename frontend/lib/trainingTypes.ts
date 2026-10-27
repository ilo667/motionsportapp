import type { TrainingType } from "./api";

// Colors of training types (calendar events, legend, history chips). Applied as inline styles
export const TYPE_COLORS: Record<TrainingType, { bg: string; border: string; text: string }> = {
  групові: { bg: "#14532d", border: "#93d23c", text: "#bbf7d0" },
  персональні: { bg: "#3b2f00", border: "#eab308", text: "#fef08a" },
  спліт: { bg: "#7c2d12", border: "#fb923c", text: "#fed7aa" },
};

// One training: a history row, a visit, a card, a refund («Групове 19:00»)
export const TYPE_LABEL: Record<TrainingType, string> = {
  групові: "Групове",
  персональні: "Персональне",
  спліт: "Спліт",
};

// The type as a kind of training: the calendar legend and type picker
export const TYPE_LABEL_PLURAL: Record<TrainingType, string> = {
  групові: "Групові",
  персональні: "Персональні",
  спліт: "Спліт",
};
