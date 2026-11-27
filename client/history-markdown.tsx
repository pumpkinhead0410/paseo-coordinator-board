import { useMemo, type ReactNode } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { Lexer, type Token, type Tokens } from "./vendor/marked/marked";
import type { Theme } from "./controls";

const codeFont = Platform.OS === "ios" ? "Menlo" : "monospace";

function inline(tokens:Token[], theme:Theme):ReactNode[] {
  return tokens.map((token,i) => {
    const children = () => "tokens" in token && token.tokens ? inline(token.tokens,theme) : "text" in token ? token.text : token.raw;
    switch (token.type) {
      case "strong": return <Text key={i} style={{fontWeight:"600"}}>{children()}</Text>;
      case "em": return <Text key={i} style={{fontStyle:"italic"}}>{children()}</Text>;
      case "del": return <Text key={i} style={{textDecorationLine:"line-through"}}>{children()}</Text>;
      case "codespan": return <Text key={i} style={{fontFamily:codeFont,fontSize:12.5,borderRadius:4,backgroundColor:theme.colors.surface2}}>{token.text}</Text>;
      case "link": {
        const href=String(token.href);
        return /^https?:\/\//i.test(href)
          ? <Text key={i} accessibilityRole="link" style={{textDecorationLine:"underline"}} onPress={()=>void openExternalUrl(href).catch(()=>{})}>{children()}</Text>
          : children();
      }
      case "br": return "\n";
      case "html": return /^<br\s*\/?\s*>$/i.test(token.raw) ? "\n" : token.raw;
      case "image": return token.text;
      case "checkbox": return token.checked ? "☑ " : "☐ ";
      default: return children() ?? token.raw;
    }
  });
}

export function HistoryMarkdown({source,theme,preview=false,heading=false,muted=false}:{
  source:string;theme:Theme;preview?:boolean;heading?:boolean;muted?:boolean;
}) {
  const tokens=useMemo(()=>Lexer.lex(source,{gfm:true,breaks:true}),[source]);
  const colors=theme.colors;
  const base:TextStyle={color:muted ? colors.foregroundMuted : colors.foreground,fontSize:muted ? 13 : 14,lineHeight:21};
  function paragraph(token:Token,i:number,style?:TextStyle,title=false) {
    return <Text key={i} accessibilityRole={title || token.type === "heading" ? "header" : undefined} selectable numberOfLines={preview ? 6 : undefined} style={[base,title && {fontSize:15,fontWeight:"600"},style]}>
      {"tokens" in token && token.tokens ? inline(token.tokens,theme) : "text" in token ? token.text : token.raw}
    </Text>;
  }
  function blocks(all:Token[],topLevel=false):ReactNode[] {
    const visible=all.filter(token=>!["space","def"].includes(token.type));
    return (topLevel && preview ? visible.slice(0,4) : visible).map((token,i)=>{
      switch (token.type) {
        case "heading": return paragraph(token,i,{fontSize:token.depth<=2 ? 15 : 14,fontWeight:"600"});
        case "hr": return <View key={i} style={{height:1,backgroundColor:colors.border}}/>;
        case "code": return paragraph(token,i,{fontFamily:codeFont,backgroundColor:colors.surface2,padding:6});
        case "blockquote": return <View key={i} style={{borderLeftWidth:2,borderColor:colors.border,paddingLeft:8,gap:4}}>{blocks(token.tokens ?? [])}</View>;
        case "list": {
          const list=token as Tokens.List;
          return <View key={i} style={{gap:4}}>{(preview ? list.items.slice(0,4) : list.items).map((item,n)=>
            <View key={n} style={{flexDirection:"row",gap:6}}>
              <Text style={base}>{list.ordered ? String(Number(list.start)+n)+"." : "•"}</Text>
              <View style={{flex:1,minWidth:0,gap:4}}>{blocks(item.tokens)}</View>
            </View>)}</View>;
        }
        case "table": {
          const table=token as Tokens.Table;
          const rows=preview ? [table.header] : [table.header,...table.rows];
          return <View key={i}>{rows.map((row,r)=><View key={r} style={{flexDirection:"row",borderBottomWidth:1,borderColor:colors.border}}>
            {row.map((cell,c)=><Text key={c} selectable style={[base,{flex:1,minWidth:0,padding:4,textAlign:cell.align ?? "left",fontWeight:cell.header ? "700" : "400"}]}>{inline(cell.tokens,theme)}</Text>)}
          </View>)}</View>;
        }
        default:return paragraph(token,i,undefined,topLevel && heading && i === 0);
      }
    });
  }
  return <View style={{gap:6}}>{blocks(tokens,true)}</View>;
}
