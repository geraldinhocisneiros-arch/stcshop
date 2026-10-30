import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtBRL } from "@/lib/format";

/** Barras de uma série só (faturamento por dia/mês). Uma série = sem legenda; o título do card nomeia. */
export function RevenueBars({
  data,
  height = 240,
}: {
  data: Array<{ label: string; value: number; hint?: string }>;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="0" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          interval="preserveStartEnd"
        />
        <YAxis
          width={56}
          tickLine={false}
          axisLine={false}
          tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
          tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))}
        />
        <Tooltip
          cursor={{ fill: "var(--color-muted)" }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const p = payload[0].payload as { label: string; value: number; hint?: string };
            return (
              <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
                <div className="font-medium">{p.label}</div>
                <div className="tabular-nums">{fmtBRL(p.value)}</div>
                {p.hint && <div className="text-muted-foreground">{p.hint}</div>}
              </div>
            );
          }}
        />
        <Bar dataKey="value" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}
