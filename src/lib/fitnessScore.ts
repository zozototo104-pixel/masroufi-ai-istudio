/**
 * Financial Fitness Score Calculator (0-100)
 * Evaluates user's financial health based on:
 * 1. Savings Rate (up to 30 pts)
 * 2. Debt to Income / Expense Ratio (up to 25 pts)
 * 3. Necessity vs Luxury Ratio (up to 25 pts)
 * 4. Transaction Regularity & Tracking Discipline (up to 20 pts)
 */

export interface FitnessScoreResult {
  score: number;
  grade: 'ممتاز' | 'جيد جداً' | 'جيد' | 'يحتاج تحسين' | 'حرج' | 'لا توجد بيانات';
  color: string;
  badgeBg: string;
  badgeBorder: string;
  summary: string;
  factors: {
    savingsScore: number;
    savingsMax: number;
    debtScore: number;
    debtMax: number;
    necessityScore: number;
    necessityMax: number;
    disciplineScore: number;
    disciplineMax: number;
  };
  tips: string[];
}

export function calculateFinancialFitness(
  totalIncome: number,
  totalExpenses: number,
  totalDebt: number,
  necessityTotal: number,
  luxuryTotal: number,
  txCount: number
): FitnessScoreResult {
  if (txCount === 0 && totalIncome === 0 && totalExpenses === 0 && totalDebt === 0) {
    return {
      score: 0,
      grade: 'لا توجد بيانات',
      color: 'text-slate-400',
      badgeBg: 'bg-slate-800/50',
      badgeBorder: 'border-slate-700',
      summary: 'قم بإضافة بعض العمليات المالية لبدء حساب مؤشر الرشاقة الخاص بك.',
      factors: {
        savingsScore: 0, savingsMax: 30,
        debtScore: 0, debtMax: 25,
        necessityScore: 0, necessityMax: 25,
        disciplineScore: 0, disciplineMax: 20
      },
      tips: []
    };
  }

  // 1. Savings Rate (Max 30)
  let savingsScore = 15;
  if (totalIncome > 0) {
    const savings = totalIncome - totalExpenses;
    const savingsRatio = savings / totalIncome;
    if (savingsRatio >= 0.3) savingsScore = 30;
    else if (savingsRatio >= 0.2) savingsScore = 25;
    else if (savingsRatio >= 0.1) savingsScore = 20;
    else if (savingsRatio >= 0) savingsScore = 15;
    else if (savingsRatio >= -0.2) savingsScore = 8;
    else savingsScore = 0;
  } else if (totalExpenses > 0) {
    savingsScore = 10;
  }

  // 2. Debt Ratio (Max 25)
  let debtScore = 25;
  if (totalDebt > 0) {
    const basis = totalIncome > 0 ? totalIncome : totalExpenses || 1000;
    const debtRatio = totalDebt / basis;
    if (debtRatio <= 0.1) debtScore = 22;
    else if (debtRatio <= 0.3) debtScore = 17;
    else if (debtRatio <= 0.6) debtScore = 10;
    else if (debtRatio <= 1.0) debtScore = 5;
    else debtScore = 0;
  }

  // 3. Necessity vs Luxury Ratio (Max 25)
  let necessityScore = 20;
  const totalExp = necessityTotal + luxuryTotal || totalExpenses;
  if (totalExp > 0) {
    const luxuryRatio = luxuryTotal / totalExp;
    if (luxuryRatio <= 0.15) necessityScore = 25;
    else if (luxuryRatio <= 0.25) necessityScore = 22;
    else if (luxuryRatio <= 0.40) necessityScore = 16;
    else if (luxuryRatio <= 0.60) necessityScore = 10;
    else necessityScore = 4;
  }

  // 4. Tracking Discipline (Max 20)
  let disciplineScore = 10;
  if (txCount >= 15) disciplineScore = 20;
  else if (txCount >= 8) disciplineScore = 16;
  else if (txCount >= 3) disciplineScore = 12;
  else disciplineScore = 8;

  const totalScore = Math.min(100, Math.max(0, Math.round(savingsScore + debtScore + necessityScore + disciplineScore)));

  let grade: FitnessScoreResult['grade'] = 'جيد';
  let color = 'text-emerald-400';
  let badgeBg = 'bg-emerald-500/10';
  let badgeBorder = 'border-emerald-500/30';
  let summary = 'وضعك المالي متوازن ورشيق مع وعي ممتاز بالإنفاق.';

  if (totalScore >= 85) {
    grade = 'ممتاز';
    color = 'text-emerald-400';
    badgeBg = 'bg-emerald-500/20';
    badgeBorder = 'border-emerald-500/40';
    summary = 'أداء مالي استثنائي! توازن رائع بين الإيرادات والمصروفات مع تحكم تام بالديون.';
  } else if (totalScore >= 70) {
    grade = 'جيد جداً';
    color = 'text-sky-400';
    badgeBg = 'bg-sky-500/20';
    badgeBorder = 'border-sky-500/40';
    summary = 'إدارة مالية سليمة ومطمئنة، مع فرص طفيفة لزيادة فائض التوفير الشهري.';
  } else if (totalScore >= 55) {
    grade = 'جيد';
    color = 'text-amber-400';
    badgeBg = 'bg-amber-500/20';
    badgeBorder = 'border-amber-500/40';
    summary = 'الميزانية مقبولة، لكن يُنصح بضبط بنود الكماليات والحد من الشراء الآجل.';
  } else if (totalScore >= 40) {
    grade = 'يحتاج تحسين';
    color = 'text-orange-400';
    badgeBg = 'bg-orange-500/20';
    badgeBorder = 'border-orange-500/40';
    summary = 'تنبيه: حجم المصروفات أو الديون يشكل ضغطاً على ميزانيتك، راجع أولويات الصرف.';
  } else {
    grade = 'حرج';
    color = 'text-rose-400';
    badgeBg = 'bg-rose-500/20';
    badgeBorder = 'border-rose-500/40';
    summary = 'وضع مالي ضاغط: المصروفات والديون تتجاوز سقف الأمان، يوصى بوقف الكماليات فوراً.';
  }

  const tips: string[] = [];
  if (luxuryTotal > necessityTotal * 0.4) {
    tips.push('💡 نسبة الكماليات مرتفعة، تقليص بند الضيافة والمطاعم سيوفر لك مبالغ مجزية.');
  }
  if (totalDebt > 0) {
    tips.push('🎯 خطة لتسديد الديون: خصص 15% من كل دخل جديد لسداد الذمم القديمة تدريجياً.');
  }
  if (totalExpenses > totalIncome && totalIncome > 0) {
    tips.push('⚠️ إنفاقك يتجاوز دخلك هذا الشهر، فعل نظام الموازنات الذكية لكل بند.');
  }
  if (tips.length === 0) {
    tips.push('🌟 استمر في هذا الأسلوب المنضبط، وضع هدفاً لتكوين صندوق طوارئ يغطي 3 أشهر.');
  }

  return {
    score: totalScore,
    grade,
    color,
    badgeBg,
    badgeBorder,
    summary,
    factors: {
      savingsScore,
      savingsMax: 30,
      debtScore,
      debtMax: 25,
      necessityScore,
      necessityMax: 25,
      disciplineScore,
      disciplineMax: 20
    },
    tips
  };
}
