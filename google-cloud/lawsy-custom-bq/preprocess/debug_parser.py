import json
import sys
import xml.etree.ElementTree as ET


# Copied from load_to_bq.py for standalone execution
def get_raw_text(element):
    if element is None:
        return ""
    return "".join(element.itertext()).strip()


# Updated robust version of format_article_text
def format_article_text(article_element):
    if article_element is None:
        return ""

    lines = []

    def get_full_text(element):
        if element is None:
            return ""
        return "".join(element.itertext()).strip()

    indent_map = {
        "Article": 0,  # Base level
        "Paragraph": 1,
        "Item": 2,
        "Subitem1": 3,
        "Subitem2": 4,
        "Subitem3": 5,
        "Subitem4": 6,
        "Subitem5": 7,
        "Subitem6": 8,
        "Subitem7": 9,
        "Subitem8": 10,
        "Subitem9": 11,
        "Subitem10": 12,
        "List": 2,
        "Table": 2,
    }

    title_tags = [f"Subitem{i}Title" for i in range(1, 11)] + [
        "ArticleCaption",
        "ArticleTitle",
        "ParagraphNum",
        "ItemTitle",
    ]
    sentence_tags = [f"Subitem{i}Sentence" for i in range(1, 11)] + [
        "ParagraphSentence",
        "ItemSentence",
    ]

    def recursive_format(element, level):

        is_structural_node = element.tag in indent_map
        if is_structural_node:
            parts = []
            title_elements = [el for el in element if el.tag in title_tags]
            sentence_elements = [el for el in element if el.tag in sentence_tags]

            parts.extend(get_full_text(el) for el in title_elements)
            parts.extend(get_full_text(el) for el in sentence_elements)

            if parts:
                lines.append("　" * level + "　".join(parts))

        child_level = level + 1 if is_structural_node else level

        for child in element:
            if child.tag in title_tags or child.tag in sentence_tags:
                continue

            if child.tag not in indent_map:
                child_text = get_full_text(child)
                if child_text:
                    lines.append("　" * child_level + child_text)
            else:
                recursive_format(child, child_level)

    recursive_format(article_element, 0)
    return "\n".join(lines)


# Copied and adapted from load_to_bq.py for standalone execution
def parse_law_xml(xml_file):
    tree = ET.parse(xml_file)
    root = tree.getroot()

    law_title = get_raw_text(root.find(".//LawTitle"))
    law_num = get_raw_text(root.find(".//LawNum"))

    chunks = []

    def process_article(article, provision_prefix):
        if article.get("Delete") == "true":
            return

        article_num = article.get("Num")
        unique_anchor = f"{provision_prefix}_Article_{article_num}"

        egov_anchor = None
        if provision_prefix == "Main":
            egov_anchor = f"Mp-At_{article_num.replace('_', '_')}"

        content = format_article_text(article)
        article_caption = get_raw_text(article.find("ArticleCaption"))
        first_paragraph = article.find(".//Paragraph")
        first_paragraph_text = (
            get_raw_text(first_paragraph.find(".//ParagraphSentence"))
            if first_paragraph is not None
            else ""
        )
        article_summary = article_caption or first_paragraph_text

        chunks.append(
            {
                "law_num": law_num,
                "law_title": law_title,
                "unique_anchor": unique_anchor,
                "anchor": egov_anchor,
                "content": content,
                "article_summary": article_summary,
            }
        )

    for article in root.findall(".//MainProvision//Article"):
        process_article(article, "Main")

    for suppl_provision in root.findall(".//SupplProvision"):
        if "AmendLawNum" in suppl_provision.attrib:
            continue
        for article in suppl_provision.findall(".//Article"):
            process_article(article, "Suppl")

    return chunks


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <XML_FILE_PATH>", file=sys.stderr)
        sys.exit(1)

    xml_file_path = sys.argv[1]

    try:
        chunks = parse_law_xml(xml_file_path)

        # Print the content of the first 3 articles for general testing
        print(f"--- Testing file: {xml_file_path} ---")
        for i, chunk in enumerate(chunks[:3]):
            print(f"--- Chunk {i + 1} ---")
            print(json.dumps(chunk, indent=2, ensure_ascii=False))

    except FileNotFoundError:
        print(f"Error: XML file not found at {xml_file_path}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"An error occurred: {e}", file=sys.stderr)
        sys.exit(1)
