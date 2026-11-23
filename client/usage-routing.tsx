import { useState } from "react";
import { Text, View } from "react-native";
import type { ProviderEntry } from "../shared/dispatch";
import { hasUsageReading, recentUsage, type AccountUsage } from "../shared/usage-routing";
import type { Theme } from "./controls";
import { useBoardLanguage } from "./language";

function AccountCard({label,report,supplemental,issue,theme}: {label:string;report?:AccountUsage;supplemental?:boolean;issue?:AccountUsage["issue"];theme:Theme}) {
  const {t,language} = useBoardLanguage();
  const c = theme.colors;
  const locale = language === "ko" ? "ko-KR" : "en-US";
  const date = (stamp:string) => new Date(stamp).toLocaleString(locale,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
  const number = (n:number) => n.toLocaleString(locale,{maximumFractionDigits:2});
  const rows = report?.status === "available" ? [
    ...report.windows.map(w => ({name:w.label,value:w.remainingPct === null ? null : number(w.remainingPct)+"%",pct:w.remainingPct,reset:w.resetsAt})),
    ...report.balances.map(b => ({
      name:b.label, value:b.remaining === null ? null : number(b.remaining)+(b.limit !== null && b.limit > 0 ? " / "+number(b.limit) : "")+" "+b.unit,
      pct:b.remaining !== null && b.limit !== null && b.limit > 0 ? Math.max(0,Math.min(100,100*b.remaining/b.limit)) : null, reset:b.resetsAt,
    })),
  ] : [];
  const stale = report && !recentUsage(report);
  return <View style={{gap:7,padding:10,borderWidth:1,borderColor:c.border,borderRadius:8,backgroundColor:c.surface0}}>
    <Text selectable style={{color:c.foreground,fontWeight:"600"}}>{[label,report?.plan].filter(Boolean).join(" · ")}</Text>
    {rows.map((row,i) => {
      const expired = !!row.reset && Date.parse(row.reset) <= Date.now();
      const pct = expired ? null : row.pct;
      const value = expired ? t("초기화 후 조회 대기","Awaiting new reading") : row.value ?? t("미확인","Unknown");
      return <View key={i} style={{gap:4}}>
        <View style={{flexDirection:"row",gap:8,alignItems:"baseline",justifyContent:"space-between",flexWrap:"wrap"}}>
          <Text style={{fontSize:13,color:c.foregroundMuted}}>{row.name}</Text>
          <Text selectable style={{fontSize:13,fontWeight:"600",color:c.foreground}}>{!expired && row.value !== null ? t(value+" 남음",value+" left") : value}</Text>
        </View>
        {pct !== null && <View accessible accessibilityRole="progressbar" accessibilityLabel={t(row.name+" 잔여량",row.name+" remaining")}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={value} style={{height:6,overflow:"hidden",borderRadius:3,backgroundColor:c.surface2}}>
          <View style={{height:"100%",width:`${pct}%`,borderRadius:3,backgroundColor:stale ? c.foregroundMuted : pct<=10 ? c.statusWarning : c.accent}} />
        </View>}
        {row.reset && !expired && <Text style={{fontSize:12,color:c.foregroundMuted}}>{t(date(row.reset)+" 초기화","Resets "+date(row.reset))}</Text>}
      </View>;
    })}
    {!rows.length && <Text style={{fontSize:13,color:c.foregroundMuted}}>{!report ? t("연결된 사용량 보고서가 없습니다.","No connected usage report.")
      : report.status === "error" ? t("사용량 조회에 실패했습니다.","Usage lookup failed.")
      : t("제공된 잔여량 수치가 없습니다.","No remaining quota reported.")}</Text>}
    {issue && <Text style={{fontSize:12,color:c.foregroundMuted}}>{issue === "login" ? t("Paseo 사용량 조회에 다시 로그인이 필요합니다.","Sign in again for Paseo usage reports.")
      : t("Paseo 사용량 조회 요청 한도에 도달했습니다.","Paseo usage lookup is rate-limited.")}</Text>}
    {report && (supplemental || report.fetchedAt) && <Text style={{fontSize:12,color:c.foregroundMuted}}>{[
      supplemental && t("호스트 추가 보고 · 표시 전용","Host report · display only"),
      report.fetchedAt && (stale ? t("이전 측정","Last known reading") : t("조회","Checked"))+" "+date(report.fetchedAt),
    ].filter(Boolean).join(" · ")}</Text>}
  </View>;
}

export function UsageRouting({providers,reports,supplemental=[],theme}:{
  providers:ProviderEntry[]; reports:AccountUsage[]; supplemental?:AccountUsage[]; theme:Theme;
}) {
  const {t} = useBoardLanguage();
  const c = theme.colors;
  const [width,setWidth] = useState(0);
  const seen = new Set([...reports,...supplemental].map(r=>r.providerId));
  const added = new Set(supplemental.filter(hasUsageReading).map(r=>r.providerId));
  const counts = new Map<string,number>();
  for (const r of reports) counts.set(r.providerId,(counts.get(r.providerId) ?? 0)+1);
  const cards = [
    ...reports.filter(r=>!added.has(r.providerId) || hasUsageReading(r) || (counts.get(r.providerId) ?? 0) > 1)
      .map(r=>({id:r.providerId,label:r.label,report:r,issue:r.issue,supplemental:false})),
    ...supplemental.map(r=>({id:r.providerId,label:r.label,report:r,issue:counts.get(r.providerId) === 1 ? reports.find(p=>p.providerId===r.providerId)?.issue : undefined,supplemental:true})),
    ...providers.filter(p=>!seen.has(p.id)).map(p=>({id:p.id,label:p.label,report:undefined,supplemental:false})),
  ];
  return <View style={{gap:9,padding:12,borderRadius:8,backgroundColor:c.surface1}}>
    <Text accessibilityRole="header" style={{color:c.foreground,fontWeight:"600"}}>{t("계정별 남은 사용량","Remaining account usage")}</Text>
    <View onLayout={e=>setWidth(e.nativeEvent.layout.width)} style={{flexDirection:"row",flexWrap:"wrap",gap:8,alignItems:"flex-start"}}>
      {cards.map((card,i)=><View key={card.id+":"+i} style={{width:width>=580 ? Math.floor((width-8)/2) : "100%"}}>
        <AccountCard {...card} theme={theme} />
      </View>)}
    </View>
    {!cards.length && <Text style={{color:c.foregroundMuted}}>{t("호스트에 사용량 보고서가 없습니다.","This host has no usage reports.")}</Text>}
    <Text style={{fontSize:12,color:c.foregroundMuted}}>{t("모델 배정은 이 호스트의 로컬 Selector 정책을 따릅니다. 직접 저장한 배정 순서가 우선합니다.","Model routing follows this host's local selector policy. Saved route priorities take precedence.")}</Text>
  </View>;
}
