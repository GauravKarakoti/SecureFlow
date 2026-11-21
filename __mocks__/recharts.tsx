import React from "react";

export const ResponsiveContainer = ({ children }: any) => (
  <div data-testid="responsive-container">{children}</div>
);
export const AreaChart = ({ data, children }: any) => (
  <svg data-testid="area-chart" data-count={data?.length}>
    {children}
  </svg>
);
export const Area = () => <g data-testid="area-series" />;
export const BarChart = ({ children }: any) => <div data-testid="bar-chart">{children}</div>;
export const Bar = () => <div data-testid="bar-series" />;
export const LineChart = ({ children }: any) => <div data-testid="line-chart">{children}</div>;
export const Line = () => <div data-testid="line-series" />;
export const XAxis = () => null;
export const YAxis = () => null;
export const CartesianGrid = () => null;
export const Tooltip = () => null;
export const Legend = () => null;
export const PieChart = ({ children }: any) => <div>{children}</div>;
export const Pie = () => null;
export const Cell = () => null;
