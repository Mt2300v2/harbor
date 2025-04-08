# --- FULL SCRIPT (Steam Store API Version) ---
import json
import os
import re
from pathlib import Path
import sys
import time
import requests # For API call and downloading assets
from bs4 import BeautifulSoup # For cleaning HTML descriptions
from urllib.parse import urlparse, unquote
import traceback

# --- Configuration ---
JSON_FILE = Path("games.json")
ASSETS_BASE_DIR = Path("assets") # Relative path from script location for downloaded assets
STEAM_API_URL = "https://store.steampowered.com/api/appdetails"
# Map API asset keys to our desired JSON keys
# Using capsule_imagev5 for 'icon' as it's the smallest standard image available
API_ASSET_MAPPING = {
    'header_image': 'header',
    'capsule_imagev5': 'capsule',
    # 'icon': None, # No direct small icon in this API - will handle later
    # 'banner': None, # No direct library banner - header is closest
    # 'logo': None, # No direct library logo - header is closest
}
REQUEST_HEADERS = { # Good practice for download requests
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
}
# Allowed extensions for assets we want to download
MEDIA_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.ico', '.webp', '.gif', '.tga', '.mp4', '.webm') # Add more if needed
DEFAULT_SIZE_STRING = "N/A" # Size info is not in this API

try:
    SCRIPT_DIRECTORY = Path(__file__).parent.resolve()
except NameError:
    SCRIPT_DIRECTORY = Path.cwd().resolve()

# --- Helper Functions ---

def load_json_data(filepath):
    """Loads game data from the JSON file."""
    if filepath.exists():
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
                if not content: return []
                stripped_content = content.strip()
                if not stripped_content: return []
                data = json.loads(stripped_content)
                return data.get('library', [])
        except json.JSONDecodeError:
            print(f"Warning: Could not decode JSON from {filepath}. Starting fresh.")
            return []
        except Exception as e:
            print(f"Error reading JSON file {filepath}: {e}")
            return []
    else:
         print(f"JSON file {filepath} not found. Starting fresh.")
    return []

def save_json_data(filepath, data):
    """Saves game data to the JSON file."""
    try:
        filepath.parent.mkdir(parents=True, exist_ok=True)
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4, ensure_ascii=False)
        print(f"Successfully saved data to {filepath}. Data: {data}")
    except Exception as e:
        print(f"Error writing JSON file {filepath}: {e}")

def sanitize_filename(filename):
    """Removes invalid characters for filenames and handles edge cases."""
    if not filename: return "downloaded_asset"
    try: filename = unquote(filename)
    except Exception: pass
    filename = filename.split('?')[0].split('#')[0] # Remove query/fragment
    sanitized = re.sub(r'[<>:"/\\|?*]', '_', filename) # Replace invalid chars
    sanitized = re.sub(r'_+', '_', sanitized) # Condense multiple underscores
    sanitized = sanitized.strip(' _.') # Remove leading/trailing junk
    # Prevent reserved names (Windows)
    reserved_names = r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$'
    if re.match(reserved_names, sanitized, re.IGNORECASE):
        sanitized = "_" + sanitized
    # Limit length for compatibility (adjust max_len if needed)
    max_len = 120
    if len(sanitized) > max_len:
        name, ext = os.path.splitext(sanitized)
        sanitized = name[:max_len - len(ext)] + ext
    return sanitized if sanitized else "downloaded_asset"

def get_file_extension(url_or_path):
    """Extracts a valid file extension from a URL or path string, checking against allowed list."""
    try:
        path_str = str(url_or_path)
        cleaned_path = path_str.split('?')[0].split('#')[0]
        ext = Path(cleaned_path).suffix.lower()
        # Check if valid and allowed
        if ext and ext != '.' and len(ext) > 1 and ext in MEDIA_EXTENSIONS:
            return ext
        # Fallback regex for URLs without clear paths
        match = re.search(r'\.([a-zA-Z0-9]+)(?:[?#]|$)', path_str)
        if match:
            potential_ext = f".{match.group(1).lower()}"
            if len(potential_ext) > 1 and potential_ext in MEDIA_EXTENSIONS:
                return potential_ext
    except Exception: pass
    return None # Return None if no valid *and allowed* extension found

def add_missing_extension(filename, url):
    """Adds a valid media file extension to a filename if missing, using URL."""
    filename_path = Path(filename)
    current_ext = filename_path.suffix.lower()
    # Check if current extension is invalid or missing
    if not current_ext or current_ext == '.' or current_ext not in MEDIA_EXTENSIONS:
        url_ext = get_file_extension(url) # Get valid extension from URL
        if url_ext:
            new_filename = str(filename_path.with_suffix(url_ext))
            return new_filename
        else:
            print(f"  Warning: Could not determine valid media extension for '{filename}' from URL {url}.")
            return filename # Return original if inference fails
    return filename # Already has a valid extension

def get_filename_from_url(url):
    """Extracts the filename component from a URL, decoding it."""
    if not url or not isinstance(url, str): return None
    try:
        path = urlparse(url).path
        # Decode URL encoding (%20 -> space, etc.) before getting basename
        filename = os.path.basename(unquote(path))
        # Handle cases like '/path/to/dir/'
        if not filename and path:
            filename = os.path.basename(unquote(path.rstrip('/')))
        return filename if filename else None
    except Exception as e:
        print(f"  Error parsing filename from URL {url}: {e}")
        return None

def download_asset_requests(url, save_path):
    """Downloads an asset from a URL using requests and saves it."""
    try:
        if not isinstance(url, str) or not url.startswith(('http://', 'https://')):
             print(f"  Warning: Skipping download for invalid URL: {url}")
             return False
        save_path.parent.mkdir(parents=True, exist_ok=True)
        print(f"  Downloading: {save_path.name} from {url[:80]}...")
        response = requests.get(url, headers=REQUEST_HEADERS, stream=True, timeout=45)
        response.raise_for_status()
        content_type = response.headers.get('content-type', '').lower()

        if 'text/html' in content_type or 'application/xml' in content_type or 'text/plain' in content_type:
             print(f"  Warning: Received text content ({content_type}) for {url}. Might be error page. Saving anyway.")

        with open(save_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192): f.write(chunk)

        downloaded_size = save_path.stat().st_size
        if downloaded_size == 0:
            print(f"  Error: Downloaded file {save_path} is empty (0 bytes). Removing.")
            save_path.unlink(missing_ok=True); return False
        elif downloaded_size < 100 and ('image' not in content_type and 'video' not in content_type):
            print(f"  Warning: Downloaded file {save_path} is very small ({downloaded_size} bytes).")

        print(f"  Saved asset to {save_path}")
        time.sleep(0.05)
        return True
    except requests.exceptions.Timeout: print(f"  Error: Timeout downloading {url}")
    except requests.exceptions.RequestException as e: print(f"  Error downloading {url}: {e}")
    except FileNotFoundError: print(f"  Error: Could not create parent directory for {save_path}.")
    except OSError as e: print(f"  Error saving file {save_path}: {e}")
    except Exception as e: print(f"  Unexpected error during download/save for {url}: {e}")
    return False

def clean_html(raw_html):
    """Removes HTML tags from a string."""
    if not raw_html: return ""
    try:
        # Use BeautifulSoup to parse and extract text
        soup = BeautifulSoup(raw_html, "html.parser")
        # Replace <br> with newlines for better readability
        for br in soup.find_all("br"):
            br.replace_with("\n")
        # Get text and remove excessive whitespace
        text = soup.get_text()
        text = re.sub(r'\n\s*\n', '\n\n', text).strip() # Condense multiple newlines
        return text
    except Exception as e:
        print(f"  Warning: Error cleaning HTML: {e}")
        return raw_html # Return raw if cleaning fails

def parse_requirements(req_data):
    """Parses the requirements dictionary (minimum/recommended)."""
    req_dict = {}
    if not isinstance(req_data, dict): return req_dict # Handle non-dict input
    for key, value in req_data.items(): # key is 'minimum' or 'recommended'
        req_dict[key] = clean_html(value) # Clean the HTML string
    return req_dict

def parse_languages(languages_string):
    """Parses the supported_languages string into a list."""
    if not languages_string: return []
    # Remove the disclaimer part
    languages_string = languages_string.split('<br>')[0]
    # Split by comma, strip whitespace and asterisks
    langs = [lang.strip().replace('<strong>*</strong>', '').strip() for lang in languages_string.split(',')]
    return sorted(list(set(filter(None, langs)))) # Remove empty strings and duplicates, then sort


# --- Main Execution ---
if __name__ == "__main__":
    print("Steam API Game Data Fetcher Initializing...")
    start_time = time.time()

    try:
        # 1. Get App ID
        app_id_input = input("Enter the Steam App ID: ").strip()
        if not app_id_input.isdigit():
            print("Error: Invalid App ID."); sys.exit(1)
        app_id_str = app_id_input

        # 2. Check existing JSON data
        library_data = load_json_data(JSON_FILE)
        existing_game = next((game for game in library_data if game.get('id') == app_id_str), None)
        if existing_game:
            print(f"Game {app_id_str} ('{existing_game.get('name', 'N/A')}') already exists. Skipping.")
            sys.exit(0)

        # 3. Fetch data from Steam API
        print(f"Fetching data for App ID {app_id_str} from Steam API...")
        api_params = {"appids": app_id_str, "l": "english"} # Request english language data
        try:
            response = requests.get(STEAM_API_URL, params=api_params, timeout=20)
            response.raise_for_status() # Raise error for bad status codes (4xx, 5xx)
            api_data = response.json()
        except requests.exceptions.RequestException as e:
            print(f"Error fetching data from Steam API: {e}")
            sys.exit(1)
        except json.JSONDecodeError:
            print(f"Error decoding JSON response from Steam API. Response text:\n{response.text[:500]}...")
            sys.exit(1)

        # 4. Validate API Response
        if not api_data or app_id_str not in api_data or not api_data[app_id_str].get('success'):
            print(f"Error: Steam API request unsuccessful or returned invalid data for App ID {app_id_str}.")
            print(f"API Response: {json.dumps(api_data, indent=2)}") # Print response for debugging
            sys.exit(1)

        game_data = api_data[app_id_str]['data']
        print(f"Successfully fetched data for: {game_data.get('name', 'Unknown Name')}")

        # 5. Prepare for Asset Download
        asset_dir = ASSETS_BASE_DIR / app_id_str
        asset_dir.mkdir(parents=True, exist_ok=True)
        downloaded_assets_map = {} # url -> relative_path
        all_urls_to_download = {} # url -> context_key

        # Identify Core Assets from API
        for api_key, json_key in API_ASSET_MAPPING.items():
            url = game_data.get(api_key)
            if url and isinstance(url, str):
                all_urls_to_download[url] = json_key # Use our internal JSON key as context

        # Identify Screenshots
        screenshots_data = game_data.get('screenshots', [])
        print(f"Identified {len(screenshots_data)} screenshots.")
        for i, ss in enumerate(screenshots_data):
            url = ss.get('path_full') # Get the full resolution URL
            if url and isinstance(url, str) and url not in all_urls_to_download:
                all_urls_to_download[url] = f"screenshot_{i}"

        # Identify Trailer Thumbnails
        trailers_data_api = game_data.get('movies', [])
        print(f"Identified {len(trailers_data_api)} trailers.")
        for i, trailer in enumerate(trailers_data_api):
            thumb_url = trailer.get('thumbnail')
            if thumb_url and isinstance(thumb_url, str) and thumb_url not in all_urls_to_download:
                 all_urls_to_download[thumb_url] = f"trailer_{i}_thumbnail"

        print(f"\nIdentified {len(all_urls_to_download)} unique asset URLs to download.")

        # 6. Download Assets
        print("-" * 20 + " Downloading Assets " + "-" * 20)
        screenshot_dir = asset_dir / "screenshots"
        trailer_dir = asset_dir / "trailers" # For thumbnails
        downloaded_screenshot_paths = []
        downloaded_trailer_thumbnails = {} # trailer_index -> relative_path

        for url, context_key in all_urls_to_download.items():
            # Determine filename and ensure extension
            filename = get_filename_from_url(url) or sanitize_filename(context_key)
            sanitized_filename = sanitize_filename(filename)
            sanitized_filename_with_ext = add_missing_extension(sanitized_filename, url)
            file_ext = Path(sanitized_filename_with_ext).suffix.lower()

            if not file_ext or file_ext not in MEDIA_EXTENSIONS:
                print(f"  Skipping download (invalid/unsupported extension): {sanitized_filename_with_ext}")
                continue

            # Determine save directory
            is_screenshot = context_key.startswith('screenshot_')
            is_trailer_thumb = context_key.startswith('trailer_') and context_key.endswith('_thumbnail')

            if is_screenshot:
                save_dir = screenshot_dir; save_dir.mkdir(parents=True, exist_ok=True)
            elif is_trailer_thumb:
                save_dir = trailer_dir; save_dir.mkdir(parents=True, exist_ok=True)
            else: # Core asset (header, capsule)
                save_dir = asset_dir

            save_path = save_dir / sanitized_filename_with_ext

            # Attempt download using requests
            if download_asset_requests(url, save_path):
                try:
                    relative_path = os.path.relpath(save_path.resolve(), SCRIPT_DIRECTORY).replace('\\', '/')
                    downloaded_assets_map[url] = relative_path # Map original URL to relative path

                    # Track specific types
                    if is_screenshot:
                        downloaded_screenshot_paths.append(relative_path)
                    elif is_trailer_thumb:
                        try:
                            trailer_index = int(context_key.split('_')[1])
                            downloaded_trailer_thumbnails[trailer_index] = relative_path
                        except (IndexError, ValueError):
                            print(f"  Warning: Could not parse index from trailer key '{context_key}'")

                except ValueError as e:
                    print(f"  Warning: Could not create relative path for {save_path}. Storing absolute.")
                    downloaded_assets_map[url] = str(save_path.resolve()).replace('\\', '/')
            # else: download_asset_requests prints errors


        # 7. Format Data for JSON
        print("-" * 20 + " Formatting Data " + "-" * 20)
        final_game_entry = {"id": app_id_str}

        # Basic Info
        final_game_entry['name'] = game_data.get('name', 'N/A')
        final_game_entry['is_free'] = game_data.get('is_free', False)
        final_game_entry['type'] = game_data.get('type', 'unknown')

        # Descriptions
        detailed_desc = clean_html(game_data.get('detailed_description', ''))
        short_desc = clean_html(game_data.get('short_description', ''))
        final_game_entry['description'] = detailed_desc if detailed_desc else short_desc

        # Developer / Publisher
        final_game_entry['developer'] = ", ".join(game_data.get('developers', [])) or "N/A"
        final_game_entry['publisher'] = ", ".join(game_data.get('publishers', [])) or "N/A"

        # Release Date
        release_info = game_data.get('release_date', {})
        final_game_entry['release_date'] = release_info.get('date', 'N/A') if not release_info.get('coming_soon') else "Coming Soon"

        # Platforms
        platforms = game_data.get('platforms', {})
        os_list = []
        if platforms.get('windows'): os_list.append("Windows")
        if platforms.get('mac'): os_list.append("macOS")
        if platforms.get('linux'): os_list.append("Linux")
        final_game_entry['supported_os'] = ", ".join(os_list) or "N/A"

        # Genres / Categories
        final_game_entry['genres'] = [g.get('description') for g in game_data.get('genres', []) if g.get('description')]
        final_game_entry['categories'] = [c.get('description') for c in game_data.get('categories', []) if c.get('description')]

        # Languages
        final_game_entry['supported_languages'] = parse_languages(game_data.get('supported_languages', ''))

        # Metacritic
        if game_data.get('metacritic'):
            final_game_entry['metacritic_score'] = game_data['metacritic'].get('score')
            final_game_entry['metacritic_url'] = game_data['metacritic'].get('url')
        else:
             final_game_entry['metacritic_score'] = None

        # Requirements
        final_game_entry['pc_requirements'] = parse_requirements(game_data.get('pc_requirements', {}))
        final_game_entry['mac_requirements'] = parse_requirements(game_data.get('mac_requirements', {}))
        final_game_entry['linux_requirements'] = parse_requirements(game_data.get('linux_requirements', {}))

        # Placeholder Fields
        final_game_entry['status'] = "Installed"
        final_game_entry['downloadPercent'] = 0
        final_game_entry['downloadSize'] = DEFAULT_SIZE_STRING
        final_game_entry['lastPlayed'] = "Never"
        final_game_entry['playTime'] = "0 minutes"

        # --- Map Downloaded Assets ---
        final_assets = {}
        # Map Header & Capsule
        for api_key, json_key in API_ASSET_MAPPING.items():
             url = game_data.get(api_key)
             if url in downloaded_assets_map:
                 final_assets[json_key] = downloaded_assets_map[url]
                 print(f"  Mapped '{json_key}' -> {final_assets[json_key]}")
             else:
                 final_assets[json_key] = None
                 print(f"  Warning: Asset for '{json_key}' (URL: {url}) was not found or failed download.")

        # Special handling for Icon (use capsule) and Banner/Logo (use header or leave null)
        final_assets['icon'] = final_assets.get('capsule') # Use capsule as icon
        final_assets['banner'] = final_assets.get('header') # Use header as banner (best guess)
        final_assets['logo'] = None # No good equivalent from API

        final_game_entry.update(final_assets) # Add mapped assets to the entry

        # Screenshots (List of relative paths)
        final_game_entry['screenshots'] = downloaded_screenshot_paths

        # Trailers (List of dicts with sources and relative thumbnail path)
        formatted_trailers = []
        for i, api_trailer in enumerate(trailers_data_api):
             trailer_entry = {
                 "id": api_trailer.get('id'),
                 "name": api_trailer.get('name'),
                 "thumbnail_path": downloaded_trailer_thumbnails.get(i), # Get relative path using index
                 "sources": { # Store direct video URLs
                       "webm_480p": api_trailer.get('webm', {}).get('480'),
                       "webm_max": api_trailer.get('webm', {}).get('max'),
                       "mp4_480p": api_trailer.get('mp4', {}).get('480'),
                       "mp4_max": api_trailer.get('mp4', {}).get('max'),
                 },
                 "highlight": api_trailer.get('highlight', False)
             }
             # Remove source entries if URL is None/empty
             trailer_entry["sources"] = {k: v for k, v in trailer_entry["sources"].items() if v}
             formatted_trailers.append(trailer_entry)
        final_game_entry['trailers'] = formatted_trailers


        # 8. Save Data
        library_data = load_json_data(JSON_FILE)
        library_data['library'].append(final_game_entry)
        save_json_data(JSON_FILE, library_data)
        print(f"\nSuccessfully added '{final_game_entry.get('name', 'N/A')}' (ID: {app_id_str}) to {JSON_FILE}")

    except KeyboardInterrupt:
        print("\nProcess interrupted by user.")
    except Exception as e:
        print(f"\nAn unexpected error occurred in the main execution block: {e}")
        traceback.print_exc()
    finally:
        end_time = time.time()
        print(f"Script finished in {end_time - start_time:.2f} seconds.")