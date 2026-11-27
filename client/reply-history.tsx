import { VerifiedSessionChip } from "./verified-session-chip";
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@getpaseo/plugin/client";
import { Image, Text, View } from "react-native";
import { pullUrl } from "../shared/prs";
import { mergeNotificationLabel } from "./merge-notification";
import { readReplyPhoto, type ReplyEntry } from "../shared/reply-history";
import { Button, type Theme } from "./controls";
import type { HistoryLinks, HistorySession } from "./history-sessions";
import { HistoryMarkdown } from "./history-markdown";
import { useBoardLanguage } from "./language";

type Props = { entry: ReplyEntry; theme: Theme; links: HistoryLinks; open?: (id:string) => void; openRemote?: (host:string,id:string) => void };

function LocalPhoto({ entryKey, index, theme }: { entryKey: string; index: number; theme: Theme }) {
  const {t} = useBoardLanguage();
  const read = useRpc(readReplyPhoto);
  const reader = useRef(read);
  reader.current = read;
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setFailed(false); setUri(null);
    void reader.current({ key: entryKey, index }).then(({image}) => {
      if (!current) return;
      if (image) setUri(`data:${image.mimeType};base64,${image.data}`);
      else setFailed(true);
    }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [entryKey, index, attempt]);
  const label = t(`첨부 사진 ${index + 1}`, `Attached photo ${index + 1}`);
  if (failed) return <View style={{alignItems:"flex-start",gap:4}}>
    <Text accessibilityLiveRegion="polite" style={{color:theme.colors.foregroundMuted}}>{t("사진을 불러오지 못했습니다.", "Could not load the photo.")}</Text>
    <Button theme={theme} label={t("다시 불러오기", "Retry loading")} onPress={() => setAttempt(n => n + 1)} />
  </View>;
  if (!uri) return <Text accessibilityLiveRegion="polite" style={{color:theme.colors.foregroundMuted}}>{t("사진 불러오는 중…","Loading photo…")}</Text>;
  return <Image accessible accessibilityLabel={label} source={{uri}} resizeMode="contain" onError={() => setFailed(true)}
    style={{ height:200, width:"100%", borderRadius:5, backgroundColor:theme.colors.surface1 }} />;
}

function SessionReference({session,state,open,openRemote,theme}:Pick<Props,"open"|"openRemote"|"theme"> & {session:HistorySession;state?:string}) {
  const {t} = useBoardLanguage();
  const role = {source:t("원래 세션","Source session"), received:t("받은 세션","Recipient session"), target:t("전송 대상","Intended recipient")}[session.role];
  const title = session.title || session.id;
  const label = [role,session.hostLabel ?? session.host,title,state].filter(Boolean).join(" · ");
  const host = session.host;
  const navigate = host ? openRemote && (() => openRemote(host,session.id)) : open && (() => open(session.id));
  if ((!session.available && !session.verify) || !navigate) return <Text selectable style={{color:theme.colors.foregroundMuted,fontSize:12}}>
    {label}{!session.available && " · " + t("연결 미확인","Connection unverified")}</Text>;
  return <VerifiedSessionChip theme={theme} label={label} accessibilityLabel={t(role+" 열기 · "+title,"Open "+role+" · "+title)}
    onPress={navigate} verify={session.available ? undefined : session.verify} />;
}

export function ReplyCard({entry, theme, links, open, openRemote}:Props) {
  const {t,language} = useBoardLanguage();
  const colors = theme.colors;
  const [full,setFull] = useState(false);
  const [showOrigin,setShowOrigin] = useState(false);
  const [photoIndex,setPhotoIndex] = useState<number | null>(null);
  const origin = entry.origin;
  const long = [entry.answer,entry.response].some(text => text && (text.length > 320 || text.split("\n").length > 6));
  const merge = entry.pullMerge;
  const status = merge
    ? (merge.status === "merged" ? t("보드에서 병합함", "Merged from board") : t("이미 병합됨", "Already merged"))
    : {
    sent:t("전송됨","Sent"), pending:t("전송 확인 중","Delivery unconfirmed"),
    unsent:t("전송 중단 · 카드 또는 수신 상태 확인 필요","Not sent · review the card or recipient"),
    recorded:t("보드에 기록함","Saved on board"), closed:entry.reviewedBy ? t("코디네이터가 확인함","Reviewed by coordinator") : t("기록 닫음","Record closed"),
  }[entry.status];
  const states = {running:t("진행 중","Running"), idle:t("대기 중","Idle"), closed:t("대화 종료","Closed"),
    error:t("오류","Error"), unknown:t("미확인","Unknown")};
  const date = new Date(entry.at).toLocaleString(language === "ko" ? "ko-KR" : "en-US",
    {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
  const sessions = links(entry);
  return <View style={{gap:5,padding:9,borderRadius:7,backgroundColor:colors.surface0,borderWidth:1,borderColor:colors.border}}>
    {merge ? <>
      <Text selectable style={{color:colors.foreground,fontWeight:"600"}}>{entry.title}</Text>
      <HistoryMarkdown theme={theme} source={`[${merge.repo} #${merge.number}](${pullUrl(merge.repo,merge.number)})`} />
    </> : <HistoryMarkdown theme={theme} source={entry.title} />}
    <Text selectable style={{color:colors.foregroundMuted,fontSize:12}}>{[status, mergeNotificationLabel(merge?.notification, t), date, merge?.mergeSha?.slice(0, 12)].filter(Boolean).join(" · ")}</Text>
    {!!sessions.length && <View style={{flexDirection:"row",flexWrap:"wrap",gap:5}}>{sessions.map(session =>
      <SessionReference key={JSON.stringify([session.role,session.host,session.id])} session={session} state={session.state && states[session.state]}
        open={open} openRemote={openRemote} theme={theme} />)}</View>}
    {!!entry.reviewReason && <HistoryMarkdown theme={theme} source={entry.reviewReason} />}
    {!!entry.answer && <HistoryMarkdown theme={theme} source={entry.answer} preview={long && !full} />}
    {!!entry.imageCount && <View style={{gap:4}}>
      <Text style={{color:colors.foregroundMuted,fontSize:12}}>{t(`첨부 사진 ${entry.imageCount}장`, `${entry.imageCount} attached photo${entry.imageCount === 1 ? "" : "s"}`)}</Text>
      {entry.localPhotos && <>
        <View style={{flexDirection:"row",flexWrap:"wrap",gap:5}}>{Array.from({length:entry.imageCount}, (_, index) =>
          <Button key={index} theme={theme} label={t(`사진 ${index + 1}`, `Photo ${index + 1}`)} expanded={photoIndex === index}
            accessibilityLabel={entry.title + " · " + t(`사진 ${index + 1}`, `Photo ${index + 1}`)}
            onPress={() => setPhotoIndex(current => current === index ? null : index)} />)}</View>
        {photoIndex !== null && <LocalPhoto key={entry.key + "/" + photoIndex} entryKey={entry.key} index={photoIndex} theme={theme} />}
      </>}
    </View>}
    {entry.status === "sent" && (entry.response
      ? <View style={{gap:4,marginTop:2,paddingVertical:8,paddingHorizontal:10,borderRadius:6,backgroundColor:colors.surface1,borderLeftWidth:3,borderLeftColor:"#3b82f6"}}>
          <Text style={{color:colors.foregroundMuted,fontSize:12}}>{t("세션의 후속 응답","Session follow-up")}</Text>
          <HistoryMarkdown theme={theme} source={entry.response} preview={long && !full} />
        </View>
      : <Text style={{color:colors.foregroundMuted,fontSize:12}}>{t("후속 응답 미확인","No verified follow-up yet")}</Text>)}
    {long && <Button theme={theme} expanded={full} label={full ? t("접기","Show less") : t("내용 펼치기","Read more")} onPress={()=>setFull(value=>!value)} />}
    {origin && <View style={{alignItems:"flex-start",gap:3}}>
      <Button theme={theme} expanded={showOrigin} label={t("답변 출처", "Reply source")} onPress={() => setShowOrigin(value => !value)} />
      {showOrigin && <Text selectable style={{color:colors.foregroundMuted,fontSize:12}}>{[
        t("원본 카드", "Source card") + " · " + origin.cardId,
        origin.questions.length ? t("질문", "Question") + " · " + origin.questions.map(q => q.id).join(", ") : "",
        origin.sessionId && t("원래 세션", "Source session") + " · " + [origin.sessionHost,origin.sessionId].filter(Boolean).join(" · "),
        t("기록 버전", "Revision") + " · " + origin.revision,
      ].filter(Boolean).join("\n")}</Text>}
    </View>}
  </View>;
}

export function ReplyHistory({entries,theme,links,open,openRemote,expanded,onToggle}:Omit<Props,"entry"> & {entries:ReplyEntry[];expanded:boolean;onToggle:()=>void}) {
  const {t} = useBoardLanguage();
  const [limit,setLimit] = useState(1);
  if (!entries.length) return null;
  return <View style={{gap:6}}>
    <Button theme={theme} expanded={expanded} onPress={onToggle} accessibilityLabel={t("최근 결정 기록","Recent decision activity")}
      label={t(`최근 결정 기록 · ${entries.length}건`,`Recent decision activity · ${entries.length}`) + (expanded ? " ▴" : " ▾")} />
    {expanded && entries.slice(0, limit).map(entry=><ReplyCard key={entry.key} entry={entry} links={links} open={open} openRemote={openRemote} theme={theme} />)}
    {expanded && entries.length > limit && <Button theme={theme} label={t("이전 기록 더 보기","Show earlier activity")} onPress={()=>setLimit(n=>n+10)} />}
  </View>;
}
