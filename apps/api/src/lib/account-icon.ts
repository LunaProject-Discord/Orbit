import { z } from "zod";

/**
 * アカウントに付けるアイコン。Lucide のアイコンの名前 (house、briefcase など) か、絵文字 1 つ。
 * 画面側が全アイコン・全絵文字から選ばせる。どちらも増えたり名前が変わったりするので、
 * ここでは形だけを確かめる (知らない名前は、画面側が色の点として出す)。
 */
const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// 絵文字を作る文字 (絵文字、肌の色、国旗の文字、囲み数字、つなぎの文字、地域の旗のタグ) だけの並び。
const EMOJI =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3|\u200D|\uFE0F|[\u{E0020}-\u{E007F}])+$/u;
export const accountIcon = z.string().refine(
  (value) =>
    // 長さは UTF-16 の単位で数える (つなげた絵文字は 1 つでも 20 を超えることがある)。
    value.length <= 64 && (ICON_NAME.test(value) || EMOJI.test(value)),
);
