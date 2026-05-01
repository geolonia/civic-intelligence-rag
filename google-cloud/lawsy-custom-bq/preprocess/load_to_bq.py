import json
import os
import sys
import xml.etree.ElementTree as ET
from concurrent.futures import ProcessPoolExecutor, as_completed

from google.cloud import bigquery, storage
from google.cloud.exceptions import NotFound
from tqdm import tqdm

PROCESSED_FILES_LOG = ".processed_files.log"


def create_gcs_bucket_if_not_exists(project_id, bucket_name, region):
    storage_client = storage.Client(project=project_id)
    try:
        storage_client.get_bucket(bucket_name)
        print(f"INFO: Bucket {bucket_name} already exists.", file=sys.stderr)
    except NotFound:
        print(
            f"INFO: Bucket {bucket_name} not found. Creating new bucket in region {region}...",
            file=sys.stderr,
        )
        storage_client.create_bucket(bucket_name, location=region)
        print(f"INFO: Bucket {bucket_name} created.", file=sys.stderr)


def create_dataset_if_not_exists(client, dataset_id, region):
    try:
        client.get_dataset(dataset_id)
        print(f"INFO: Dataset {dataset_id} already exists.", file=sys.stderr)
    except NotFound:
        print(
            f"INFO: Dataset {dataset_id} not found. Creating it now in region {region}...",
            file=sys.stderr,
        )
        dataset = bigquery.Dataset(client.dataset(dataset_id))
        dataset.location = region
        client.create_dataset(dataset, timeout=30)
        print(f"SUCCESS: Dataset {dataset_id} created.", file=sys.stderr)


def get_raw_text(element):
    if element is None:
        return ""
    return "".join(element.itertext()).strip()


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

    # 1. Process Main Provision Articles
    for article in root.findall(".//MainProvision//Article"):
        process_article(article, "Main")

    # 2. Process Original Supplementary Provision Articles
    for suppl_provision in root.findall(".//SupplProvision"):
        if "AmendLawNum" in suppl_provision.attrib:
            continue
        for article in suppl_provision.findall(".//Article"):
            process_article(article, "Suppl")

    return chunks


def process_file(file_path):
    try:
        law_id = os.path.splitext(os.path.basename(file_path))[0]
        tree = ET.parse(file_path)
        xml_root = tree.getroot()

        era = xml_root.get("Era")
        year_str = xml_root.get("Year")
        year = int(year_str) if year_str and year_str.isdigit() else 0

        law_type = xml_root.get("LawType")
        promulgate_month_str = xml_root.get("PromulgateMonth")
        promulgate_day_str = xml_root.get("PromulgateDay")
        promulgate_month = (
            int(promulgate_month_str)
            if promulgate_month_str and promulgate_month_str.isdigit()
            else 1
        )
        promulgate_day = (
            int(promulgate_day_str) if promulgate_day_str and promulgate_day_str.isdigit() else 1
        )

        if era == "Meiji":
            gregorian_year = 1867 + year
        elif era == "Taisho":
            gregorian_year = 1911 + year
        elif era == "Showa":
            gregorian_year = 1925 + year
        elif era == "Heisei":
            gregorian_year = 1988 + year
        elif era == "Reiwa":
            gregorian_year = 2018 + year
        else:
            gregorian_year = year

        promulgate_date = f"{gregorian_year:04d}-{promulgate_month:02d}-{promulgate_day:02d}"

        article_chunks = parse_law_xml(file_path)

        rows = [
            {
                "law_id": law_id,
                "law_num": chunk["law_num"],
                "law_title": chunk["law_title"],
                "unique_anchor": chunk["unique_anchor"],
                "anchor": chunk["anchor"],
                "content": chunk["content"],
                "article_summary": chunk["article_summary"],
                "era": era,
                "year": year,
                "law_type": law_type,
                "promulgate_date": promulgate_date,
            }
            for chunk in article_chunks
        ]
        return rows, file_path
    except Exception as e:
        print(f"ERROR: Error processing file {file_path}: {e}", file=sys.stderr)
        return [], file_path


def load_to_bq(
    project_id, dataset_id, source_directory, gcs_bucket_name, gcs_blob_name, region, date_tag
):
    storage_client = storage.Client(project=project_id)
    bigquery_client = bigquery.Client(project=project_id, location=region)

    create_gcs_bucket_if_not_exists(project_id, gcs_bucket_name, region)
    create_dataset_if_not_exists(bigquery_client, dataset_id, region)

    table_id = f"source_laws_{date_tag}"
    table_ref = bigquery_client.dataset(dataset_id).table(table_id)

    processed_files = set()
    if os.path.exists(PROCESSED_FILES_LOG):
        with open(PROCESSED_FILES_LOG) as f:
            processed_files = set(f.read().splitlines())

    files_to_process = []
    for root_dir, _, files in os.walk(source_directory):
        for file in files:
            if file.endswith(".xml"):
                file_path = os.path.join(root_dir, file)
                if file_path not in processed_files:
                    files_to_process.append(file_path)

    if not files_to_process:
        print("INFO: No new files to process.", file=sys.stderr)
        return

    jsonl_file_path = "data.jsonl"
    with ProcessPoolExecutor() as executor, open(jsonl_file_path, "w", encoding="utf-8") as f:
        future_to_file = {
            executor.submit(process_file, file_path): file_path for file_path in files_to_process
        }

        for future in tqdm(
            as_completed(future_to_file), total=len(files_to_process), desc="Processing files"
        ):
            rows, _ = future.result()
            if rows:
                for row in rows:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")

    bucket = storage_client.bucket(gcs_bucket_name)
    blob = bucket.blob(gcs_blob_name)

    print(
        f"INFO: Uploading {jsonl_file_path} to gs://{gcs_bucket_name}/{gcs_blob_name}",
        file=sys.stderr,
    )
    blob.upload_from_filename(jsonl_file_path)
    print("INFO: Upload complete.", file=sys.stderr)

    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        autodetect=False,
        schema=[
            bigquery.SchemaField("law_id", "STRING"),
            bigquery.SchemaField("law_num", "STRING"),
            bigquery.SchemaField("law_title", "STRING"),
            bigquery.SchemaField("unique_anchor", "STRING"),
            bigquery.SchemaField("anchor", "STRING"),
            bigquery.SchemaField("content", "STRING"),
            bigquery.SchemaField("article_summary", "STRING"),
            bigquery.SchemaField("era", "STRING"),
            bigquery.SchemaField("year", "INTEGER"),
            bigquery.SchemaField("law_type", "STRING"),
            bigquery.SchemaField("promulgate_date", "DATE"),
        ],
        write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
    )

    gcs_uri = f"gs://{gcs_bucket_name}/{gcs_blob_name}"

    print(
        f"INFO: Starting BigQuery load job from {gcs_uri} to {dataset_id}.{table_id}",
        file=sys.stderr,
    )
    load_job = bigquery_client.load_table_from_uri(
        gcs_uri, table_ref, job_config=job_config, location=region
    )

    load_job.result()

    print(f"INFO: Loaded {load_job.output_rows} rows to {dataset_id}.{table_id}", file=sys.stderr)

    with open(PROCESSED_FILES_LOG, "a") as log_file:
        for file_path in files_to_process:
            log_file.write(f"{file_path}\n")

    print(f"{project_id}.{dataset_id}.{table_id}")


if __name__ == "__main__":
    if len(sys.argv) != 8:
        print(
            "Usage: python3 load_to_bq.py <project_id> <dataset_id> <source_directory> <gcs_bucket_name> <gcs_blob_name> <region> <date_tag>",
            file=sys.stderr,
        )
        sys.exit(1)
    else:
        project_id = sys.argv[1]
        dataset_id = sys.argv[2]
        source_directory = sys.argv[3]
        gcs_bucket_name = sys.argv[4]
        gcs_blob_name = sys.argv[5]
        region = sys.argv[6]
        date_tag = sys.argv[7]
        load_to_bq(
            project_id,
            dataset_id,
            source_directory,
            gcs_bucket_name,
            gcs_blob_name,
            region,
            date_tag,
        )
