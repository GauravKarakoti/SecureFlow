"use client";

import React from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const mockFindings = [
  { id: "SEC-01", title: "Hardcoded Database Credentials", severity: "CRITICAL", asset: "backend-api", date: "2026-06-28" },
  { id: "SEC-02", title: "Permissive CORS Policy Configurations", severity: "HIGH", asset: "gateway-proxy", date: "2026-06-29" },
  { id: "SEC-03", title: "Outdated Dependency Version (lodash)", severity: "LOW", asset: "frontend-dashboard", date: "2026-07-01" },
];

export default function FindingsClient() {
  return (
    <div className="w-full space-y-6 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Security Findings</h1>
        <p className="text-sm sm:text-base text-muted-foreground mt-1">
          Review, sort, and mitigate automated code analysis results.
        </p>
      </div>

      <Card className="w-full border shadow-sm">
        <CardHeader className="p-4 sm:p-6">
          <CardTitle className="text-base sm:text-lg">Vulnerabilities Detected</CardTitle>
        </CardHeader>
          <CardContent className="p-0 sm:p-6 sm:pt-0">
            {/* Scroll block protecting tables on screen views < 768px */}
            <div className="w-full overflow-x-auto border-b sm:border sm:rounded-lg">
              <Table className="min-w-[700px] w-full table-auto">
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[100px] px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                      ID
                    </TableHead>
                    <TableHead className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                      Vulnerability
                    </TableHead>
                    <TableHead className="w-[120px] px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                      Severity
                    </TableHead>
                    <TableHead className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider">
                      Asset
                    </TableHead>
                    <TableHead className="w-[120px] text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {mockFindings.map((finding) => (
                    <TableRow
                      key={finding.id}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      <TableCell className="px-4 py-3 text-sm font-mono text-muted-foreground">
                        {finding.id}
                      </TableCell>

                      <TableCell className="px-4 py-3 text-sm font-medium text-foreground max-w-xs truncate">
                        {finding.title}
                      </TableCell>

                      <TableCell className="px-4 py-3">
                        <Badge
                          variant={
                            finding.severity === "CRITICAL"
                              ? "destructive"
                              : finding.severity === "HIGH"
                              ? "default"
                              : "secondary"
                          }
                          className="text-xs px-2 py-0.5 font-semibold"
                        >
                          {finding.severity}
                        </Badge>
                      </TableCell>

                      <TableCell className="px-4 py-3 text-sm text-muted-foreground">
                        {finding.asset}
                      </TableCell>

                      <TableCell className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="min-h-[36px] px-3 text-xs hover:bg-primary hover:text-primary-foreground transition-all"
                        >
                          Investigate
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
        </CardContent>
      </Card>
    </div>
  );
}