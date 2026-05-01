import logging
import re

from .retrieval_bq import FullArticle  # noqa: F401 – imported for callers' type context

logger = logging.getLogger(__name__)


def _build_ref_map(references: list) -> dict:
    """references リスト（タプル or オブジェクト）を {citation_num: ref_data} の辞書に変換する。
    タプル形式 (original_index, ref) の場合は original_index をキーとして使用し、
    20番台以降の引用番号でもルックアップできるようにする。
    """
    ref_map = {}
    for i, item in enumerate(references, start=1):
        if isinstance(item, tuple):
            original_index, ref_data = item
            ref_map[original_index] = ref_data
        else:
            ref_map[i] = item
    return ref_map


def _normalize_content(text: str, max_len: int = 200) -> str:
    """content/snippet をインライン表示用に正規化する。

    法令条文は改行＋全角スペースで項目が区切られているため、
    blockquote（> ...）に埋め込むと改行が blockquote を壊す。
    改行と後続の空白をスペースに置換して1行化する。
    """
    normalized = re.sub(r"\n\u3000*", " ", text).strip()
    return normalized[:max_len]


def _format_reference(i, r):
    if hasattr(r, "title"):  # FullArticle (条文)の場合
        title = r.title
        content = _normalize_content(r.content) if r.content else ""
        url = str(r.url) if r.url else ""
        content_line = f"\n　　> {content}..." if content else ""
        if url:
            return f"[{i + 1}] 🔗 **[{title}]({url})**{content_line}"
        else:
            return f"[{i + 1}] **{title}**{content_line}"
    else:  # Web検索結果の場合
        title = r.get("title", "No title")
        content = _normalize_content(r.get("snippet", ""))
        url = r.get("url", "")
        content_line = f"\n　　> {content}" if content else ""
        if url:
            return f"[{i + 1}] 🔗 **[{title}]({url})**{content_line}"
        else:
            return f"[{i + 1}] **{title}**{content_line}"


def _format_reference_for_prompt(i, r):
    """Geminiプロンプト向けフォーマット（URLなし・e-laws条文はラベル付き全文）"""
    if hasattr(r, "title"):  # FullArticle（e-laws公式条文）
        content = r.content or ""
        return f"[{i + 1}] 【e-laws公式条文】 {r.title}\n{content}"
    else:  # Web検索結果
        title = r.get("title", "")
        snippet = r.get("snippet", "")
        content_line = f"\n{snippet}" if snippet else ""
        return f"[{i + 1}] {title}{content_line}"


def sanitize_mermaid_content(text):
    """Mermaidコードブロック内の危険な記号を安全な文字に置換してパースエラーを防ぐ"""

    def sanitize_mermaid_block(match):
        mermaid_content = match.group(1)

        # Mermaid構文パターンを保護するために一時的にプレースホルダーに置換
        protected_patterns = {
            "___ARROW_RIGHT___": "-->",
            "___ARROW_LEFT___": "<--",
            "___ARROW_BOTH___": "<-->",
            "___ARROW_DOTTED___": "-.-",
            "___ARROW_THICK___": "===",
            "___ARROW_OPEN___": "---",
            "___COLON_SPACE___": ": ",  # ノード定義用
            "___PIPE_PIPE___": "||",  # 条件分岐用
            "___AMP_AMP___": "&&",  # 条件分岐用
        }

        # 1. Mermaid構文を保護（プレースホルダーに置換）
        protected_content = mermaid_content
        for placeholder, pattern in protected_patterns.items():
            protected_content = protected_content.replace(pattern, placeholder)

        # 2. 危険な記号の置換（ノードラベル内のみ対象）
        def sanitize_label_content(label_content):
            """ラベル内容の危険な記号のみを置換"""
            # ノードラベル内でのみ置換するルール
            label_replacements = [
                # 入れ子構造記号（ノードラベル内のみ）
                ("(", "（"),
                (")", "）"),
                ("[", "［"),
                ("]", "］"),
                ("{", "｛"),
                ("}", "｝"),
                # 特殊記号
                ("・", "/"),
                ("#", "＃"),
                ("*", "＊"),
                # 引用符
                ('"', "\u201c"),
                ("'", "\u2018"),
                # HTMLタグ風（ノードラベル内のみ）
                ("<", "＜"),
                (">", "＞"),
                ("&", "＆"),
                # 改行を<br>に変換
                ("\n", "<br>"),
            ]

            sanitized_label = label_content
            for old_char, new_char in label_replacements:
                sanitized_label = sanitized_label.replace(old_char, new_char)

            return sanitized_label

        # 3. ノードラベル（括弧内）のみを対象に置換
        sanitized = protected_content
        # パターン: ノード名(ラベル内容)
        sanitized = re.sub(
            r"\(([^)]+)\)", lambda m: f"({sanitize_label_content(m.group(1))})", sanitized
        )
        # パターン: ノード名[ラベル内容]
        sanitized = re.sub(
            r"\[([^\]]+)\]", lambda m: f"[{sanitize_label_content(m.group(1))}]", sanitized
        )
        # パターン: ノード名{ラベル内容}
        sanitized = re.sub(
            r"\{([^}]+)\}", lambda m: f"{{{sanitize_label_content(m.group(1))}}}", sanitized
        )

        # 4. 保護されたMermaid構文を復元
        for placeholder, pattern in protected_patterns.items():
            sanitized = sanitized.replace(placeholder, pattern)

        # 5. 連続する空白を正規化（構文部分は除く）
        lines = sanitized.split("\n")
        normalized_lines = []
        for line in lines:
            # Mermaid構文行（矢印を含む行）は空白正規化しない
            if "-->" in line or "<--" in line or "---" in line or "===" in line:
                normalized_lines.append(line)
            else:
                normalized_lines.append(re.sub(r"\s+", " ", line.strip()))

        return f"```mermaid\n{chr(10).join(normalized_lines)}\n```"

    # mermaidコードブロックのみを対象に置換
    return re.sub(r"```mermaid\n(.*?)\n```", sanitize_mermaid_block, text, flags=re.DOTALL)


def convert_citation_to_external_link(text, references):
    """本文中の[数字]および[数字,数字,...]表記を対応する参照の外部URLに直接リンク（mermaidコードブロック内は除外）"""

    # original_index をキーとした辞書でルックアップ（20番台以降のバグ修正）
    ref_map = _build_ref_map(references)

    def _link_single(num: int) -> str:
        """単一引用番号をリンクに変換。URLがなければプレーンテキストで返す。"""
        ref_data = ref_map.get(num)
        if ref_data is None:
            return f"[{num}]"
        if hasattr(ref_data, "url") and ref_data.url:
            return f"[[{num}]]({ref_data.url})"
        elif isinstance(ref_data, dict) and ref_data.get("url"):
            return f"[[{num}]]({ref_data['url']})"
        return f"[{num}]"

    def replace_citation(match):
        """[n] または [n, m, ...] をリンクに展開する。"""
        inner = match.group(1)
        nums = [int(s.strip()) for s in inner.split(",")]
        if len(nums) == 1:
            return _link_single(nums[0])
        # 複数番号: 個別リンクをスペースで連結
        return " ".join(_link_single(n) for n in nums)

    # mermaidコードブロックを特定し、その範囲を記録
    mermaid_blocks = [
        (match.start(), match.end())
        for match in re.finditer(r"```mermaid\n(.*?)\n```", text, re.DOTALL)
    ]

    def is_in_mermaid_block(pos):
        """指定位置がmermaidブロック内かどうかを判定"""
        return any(start <= pos <= end for start, end in mermaid_blocks)

    def conditional_replace(match):
        """mermaidブロック内でなければリンク変換を実行"""
        if is_in_mermaid_block(match.start()):
            return match.group(0)  # 変更しない
        else:
            return replace_citation(match)

    # [数字] および [数字, 数字, ...] の形式を検索してリンクに変換（mermaidブロック内は除外）
    return re.sub(r"\[(\d+(?:,\s*\d+)*)\]", conditional_replace, text)
