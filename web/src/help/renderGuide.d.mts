export interface GuideItem { name: string; what: string }
export interface Guide { tips: Record<string, string>; sections: { title: string; items: GuideItem[] }[] }
export function renderGuide(g: Guide): string;
