import csv
import json
import sys
import collections

def convert_csv_to_json(input_file_path, output_file_path):
    """
    Reads a complex CSV file, groups the data by paper and artifact,
    and writes it to a structured JSON file.
    """
    
    papers_map = collections.OrderedDict()

    try:
        with open(input_file_path, mode='r', encoding='utf-8') as infile:
            reader = csv.DictReader(infile)
            
            for row in reader:
                arxiv_id = row['arxiv_id']
                artifact_id = row['artifact_id']

                if arxiv_id not in papers_map:
                    papers_map[arxiv_id] = {
                        "id": arxiv_id,
                        "title": row.get('arxiv_title', ''),
                        "artifacts_map": collections.OrderedDict()
                    }
                else:
                    # Update title if present and previous title is empty/missing
                    new_title = (row.get('arxiv_title') or '').strip()
                    papers_map[arxiv_id].setdefault('title', row.get('arxiv_title'))
                
                paper = papers_map[arxiv_id]

                if artifact_id not in paper["artifacts_map"]:
                    paper["artifacts_map"][artifact_id] = {
                        "id": artifact_id,
                        "text": row['artifact_text'],
                        "queries": []
                    }
                
                artifact = paper["artifacts_map"][artifact_id]                
                artifact["queries"].append(row)

    except FileNotFoundError:
        print(f"Error: The file '{input_file_path}' was not found.")
        sys.exit(1)
    except Exception as e:
        print(f"An error occurred while reading the CSV: {e}")
        sys.exit(1)

    final_data = []
    for paper in papers_map.values():
        # Convert the artifacts map to a list for the final JSON
        paper["artifacts"] = list(paper.pop("artifacts_map").values())
        final_data.append(paper)

    try:
        with open(output_file_path, mode='w', encoding='utf-8') as outfile:
            # Use indent=2 for a readable JSON file (good for debugging)
            json.dump(final_data, outfile, indent=2)
        print(f"Successfully converted '{input_file_path}' to '{output_file_path}'")
    except Exception as e:
        print(f"An error occurred while writing the JSON file: {e}")
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python convert_csv.py <input_csv_file> <output_json_file>")
        print("Example: python convert_csv.py detailed_log.csv data.json")
        sys.exit(1)
        
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    convert_csv_to_json(input_path, output_path)
