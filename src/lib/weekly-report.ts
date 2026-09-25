const day = (d: Date) => d.toISOString().slice(0, 10);

/** Last full week (Monday to Monday, UTC) and the one before, relative to `now`. */
export function reportWeeks(now: Date) {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  const shift = (days: number) => new Date(monday.getTime() + days * 86_400_000);
  return { from: day(shift(-7)), to: day(monday), prevFrom: day(shift(-14)), lastDay: day(shift(-1)) };
}

/** The question the agent answers every Monday. Edit the sections here to change the report. */
export function weeklyReportPrompt(now: Date) {
  const { from, to, prevFrom, lastDay } = reportWeeks(now);
  return `Prepara l'informe setmanal per a l'equip, en català, de la setmana del ${from} al ${lastDay} (createdAt >= ${from} i < ${to}), comparant amb la setmana anterior (>= ${prevFrom} i < ${from}).
És un informe, no una resposta curta: fins a ~25 línies, amb un títol en negreta per secció i punts curts. Si una secció no té dades, digues-ho en una línia.

1. **Despesa d'IA**: total en USD i crides (IntegrationDB.AIUsageEvents) i variació en % respecte a la setmana anterior. Top 3 clients i top 3 projectes per dòlars, amb noms (ClientDB.Business, ProjectsDB.Projects). Afegeix el cost de smart notifications i smart translations des de Langfuse.
2. **Novetats**: projectes nous creats (ProjectsDB.Projects per createdAt, per tipus) i clients que han fet servir IA aquesta setmana però no l'anterior.
3. **Anomalies**: a Langfuse, observacions amb level ERROR per traceName i latència p95 de project-builder-chat i help-center.chat, comparades amb la setmana anterior. Destaca només el que canviï clarament (per exemple, +50%) o digues que no n'hi ha.
4. **Ús del backoffice** (PostHog): negocis actius (uniq business_id amb $pageview, sense hosts *.goil.dev), els 5 mòduls més visitats i preguntes al xat del centre d'ajuda, comparat amb la setmana anterior.

Acaba amb una línia "👀 A destacar:" amb la conclusió més important.`;
}
