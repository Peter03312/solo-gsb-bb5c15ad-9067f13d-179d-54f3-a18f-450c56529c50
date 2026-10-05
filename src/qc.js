'use strict';

/* ================= 字幕质检（QC） =================
 *
 * 每个视频可分别为原文轨（track='source'）与已启用译文轨（track='translation'）
 * 配置两个独立阈值：
 *   - max_cps        最大每秒字符数（正数，可小数）
 *   - max_line_chars 最大单行字符数（正整数）
 * 阈值未配置（null）的指标不检查、不阻断。
 *
 * 计数规则：
 *   - 按 Unicode 码点计数（Array.from 按码点迭代，emoji/代理对各算 1）；
 *   - 换行符（\n / \r）不计入字符数；多行文本逐行计单行字符数（取最长行）；
 *   - 速度 cps = 字符数 / 片段时长（秒），按片段时长换算（时长为毫秒整数）。
 */

// 去掉换行后的码点字符数（\r、\n 均不计）
function charCount(text) {
  const stripped = String(text == null ? '' : text).replace(/[\r\n]/g, '');
  return Array.from(stripped).length;
}

// 各行码点字符数（换行已在文本入库时规范化为 \n；同时兼容 \r）
function lineLengths(text) {
  return String(text == null ? '' : text)
    .split(/\r\n|\n|\r/)
    .map((line) => Array.from(line).length);
}

// 返回 { chars, duration_ms, cps, longest_line_chars }；时长恒为正（片段 end>start）
function measureText(text, startMs, endMs) {
  const chars = charCount(text);
  const durationMs = Math.max(0, endMs - startMs);
  const lines = lineLengths(text);
  return {
    chars,
    duration_ms: durationMs,
    cps: durationMs > 0 ? (chars * 1000) / durationMs : 0,
    longest_line_chars: lines.reduce((m, n) => (n > m ? n : m), 0),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 规则映射：track('source'|'translation') -> 规则行（可能为 undefined）
function mapRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    video_id: row.video_id,
    track: row.track,
    language: row.language != null ? row.language : null,
    max_cps: row.max_cps == null ? null : row.max_cps,
    max_line_chars: row.max_line_chars == null ? null : row.max_line_chars,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// 判断一条放行是否对某个具体违规当前仍然有效：
// 绑定片段时间、文本、轨道语言与当时阈值，任一变化即失效（历史行仍保留）。
function waiverMatches(w, v) {
  return (
    w.track === v.track &&
    w.kind === v.kind &&
    (w.language == null ? null : w.language) === (v.language == null ? null : v.language) &&
    w.bound_start_ms === v.start_ms &&
    w.bound_end_ms === v.end_ms &&
    w.bound_text === v.text &&
    (w.kind === 'cps'
      ? Number(w.bound_max_cps) === Number(v.threshold)
      : Number(w.bound_max_line_chars) === Number(v.threshold))
  );
}

function mapWaiver(w) {
  return {
    id: w.id,
    video_id: w.video_id,
    segment_id: w.segment_id,
    track: w.track,
    kind: w.kind,
    language: w.language == null ? null : w.language,
    bound_start_ms: w.bound_start_ms,
    bound_end_ms: w.bound_end_ms,
    bound_text: w.bound_text,
    bound_max_cps: w.bound_max_cps == null ? null : w.bound_max_cps,
    bound_max_line_chars: w.bound_max_line_chars == null ? null : w.bound_max_line_chars,
    reason: w.reason,
    created_by: w.created_by,
    created_at: w.created_at,
  };
}

/* 对当前草稿做一次全量质检。
 * 参数：
 *   video        视频行（含 duration_ms、translation_lang）
 *   segments     原文片段（mapSegment 后的对象或原始行均可）
 *   translations listTranslations 结果（译文未启用时传 []）
 *   ruleRows     qc_rules 原始行数组
 *   waiverRows   qc_waivers 原始行数组
 * 返回 { checked_tracks, rules, segments:[{segment_id,start_ms,end_ms,tracks}],
 *        violations, unwaived_count, waived_count, can_publish, generated_at }
 */
function runQc(video, segments, translations, ruleRows, waiverRows) {
  const rules = {};
  for (const row of ruleRows || []) {
    rules[row.track] = mapRule(row);
  }

  const tracksToCheck = [];
  if (rules.source) tracksToCheck.push('source');
  // 译文规则只在轨道已启用时生效；停用期间规则不产生任何阻断
  if (rules.translation && video.translation_lang) tracksToCheck.push('translation');

  const trBySeg = new Map((translations || []).map((t) => [t.segment_id, t]));
  const allViolations = [];

  const outSegments = segments.map((s) => {
    const trackResults = {};
    for (const track of tracksToCheck) {
      const language = track === 'translation' ? video.translation_lang : null;
      let text;
      let missing = false;
      if (track === 'source') {
        text = s.text;
      } else {
        const tr = trBySeg.get(s.id);
        if (!tr) { missing = true; text = ''; }
        else text = tr.text;
      }
      const rule = rules[track];
      const metrics = measureText(text, s.start_ms, s.end_ms);
      const violations = [];
      if (!missing) {
        if (rule.max_cps != null && metrics.cps > rule.max_cps) {
          violations.push({
            track,
            language,
            kind: 'cps',
            threshold: rule.max_cps,
            actual: round2(metrics.cps),
            chars: metrics.chars,
            duration_ms: metrics.duration_ms,
            message: `每秒字符数 ${round2(metrics.cps)} 超过阈值 ${rule.max_cps}`
              + `（${metrics.chars} 字符 / ${(metrics.duration_ms / 1000).toFixed(3)} 秒，换行不计）`,
          });
        }
        if (rule.max_line_chars != null && metrics.longest_line_chars > rule.max_line_chars) {
          const lens = lineLengths(text);
          const lineNo = lens.indexOf(metrics.longest_line_chars) + 1;
          violations.push({
            track,
            language,
            kind: 'line_chars',
            threshold: rule.max_line_chars,
            actual: metrics.longest_line_chars,
            line: lineNo,
            line_count: lens.length,
            message: `单行字符数 ${metrics.longest_line_chars} 超过阈值 ${rule.max_line_chars}`
              + `（第 ${lineNo} 行，按 Unicode 码点计数，换行不计）`,
          });
        }
      }
      trackResults[track] = {
        language,
        text_missing: missing,
        metrics: {
          chars: metrics.chars,
          duration_ms: metrics.duration_ms,
          cps: round2(metrics.cps),
          longest_line_chars: metrics.longest_line_chars,
        },
        violations,
      };
      for (const v of violations) {
        allViolations.push({
          segment_id: s.id,
          start_ms: s.start_ms,
          end_ms: s.end_ms,
          text,
          ...v,
        });
      }
    }
    return { segment_id: s.id, start_ms: s.start_ms, end_ms: s.end_ms, tracks: trackResults };
  });

  // 为每个违规匹配当前有效的放行
  const violations = allViolations.map((v) => {
    const matched = (waiverRows || []).find((w) => waiverMatches(w, v));
    return {
      ...v,
      waived: !!matched,
      waiver: matched
        ? { id: matched.id, reason: matched.reason, created_by: matched.created_by, created_at: matched.created_at }
        : null,
    };
  });

  const waivedCount = violations.filter((v) => v.waived).length;
  const unwaivedCount = violations.length - waivedCount;

  return {
    checked_tracks: tracksToCheck,
    rules,
    segments: outSegments,
    violations,
    unwaived_count: unwaivedCount,
    waived_count: waivedCount,
    can_publish: unwaivedCount === 0,
    generated_at: Date.now(),
  };
}

module.exports = {
  SOURCE_TRACK: 'source',
  TRANSLATION_TRACK: 'translation',
  charCount,
  lineLengths,
  measureText,
  mapRule,
  mapWaiver,
  waiverMatches,
  runQc,
};
