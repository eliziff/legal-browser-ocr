use legal_pdf_core::{Line, Page, Span};
use legal_pdf_structure::{derive, StructureIdentity};
use legal_structure::{analyze_instrument, provider_text_document_structure, ProviderTextInput, ProviderTextSourceKind};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct BrowserInput { text: String, pages: Vec<BrowserPage> }
#[derive(Deserialize)]
struct BrowserPage { width: f64, height: f64, lines: Vec<BrowserLine> }
#[derive(Deserialize)]
struct BrowserLine { text: String, x: f64, y: f64, width: f64, height: f64 }

#[no_mangle]
pub extern "C" fn allocate(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

#[no_mangle]
pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
    drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)));
}

#[no_mangle]
pub unsafe extern "C" fn detect(ptr: *const u8, len: usize, profile: u32) -> u64 {
    let response = if len > 4_000_000 {
        json!({"error": "This experiment supports up to 4 MB of OCR data."})
    } else {
        match serde_json::from_slice::<BrowserInput>(std::slice::from_raw_parts(ptr, len)) {
            Ok(input) => detect_input(input, profile),
            Err(_) => json!({"error": "Invalid OCR data."}),
        }
    };
    pack(response)
}

fn detect_input(input: BrowserInput, profile: u32) -> serde_json::Value {
    if profile == 0 {
        let mut pages = pdf_pages(input.pages);
        let separators = vec![None; pages.len()];
        return match derive(&mut pages, &separators, StructureIdentity {
            document_id: "browser-ocr".into(), source_sha256: String::new(),
        }) {
            Ok(output) => json!({"nodes": output.structure_graph.nodes, "offset_unit": output.structure_graph.offset_unit}),
            Err(error) => json!({"error": error.to_string()}),
        };
    }
    let result = match profile {
        1 => provider_text_document_structure(ProviderTextInput::new("", ProviderTextSourceKind::Laws, &input.text)),
        2 => analyze_instrument(&input.text, "browser-ocr".into(), &[], false),
        _ => return json!({"error": "Unknown document profile."}),
    };
    match result {
        Ok(document) => json!({"nodes": document.nodes, "offset_unit": document.offset_unit}),
        Err(error) => json!({"error": error.to_string()}),
    }
}

fn pdf_pages(source: Vec<BrowserPage>) -> Vec<Page> {
    source.into_iter().enumerate().map(|(page_index, page)| {
        let lines = page.lines.into_iter().enumerate().map(|(line_index, line)| {
            let bbox = [line.x, line.y, line.x + line.width, line.y + line.height];
            let end = line.text.chars().count();
            Line {
                id: format!("p{}-l{}", page_index + 1, line_index + 1),
                page_index, page_number: (page_index + 1) as u32, source_index: line_index,
                reading_order: line_index, block_index: line_index, text: line.text.clone(), bbox,
                spans: vec![Span { id: format!("p{}-l{}-s1", page_index + 1, line_index + 1),
                    text: line.text, bbox, font: String::new(), size: line.height, flags: 0,
                    superscript: false, start: 0, end }],
                words: vec![], detached_references: vec![], exclude_from_body: false,
                suppress_footnote_label: false, note_region_mode: String::new(),
                region_id: String::new(), region_type: "body".into(), source: "ocr".into(),
            }
        }).collect();
        Page { id: format!("page-{}", page_index + 1), index: page_index,
            number: (page_index + 1) as u32, width: page.width, height: page.height, lines,
            regions: vec![], source: "ocr".into(), text_quality: 1.0, printed_label: None,
            printed_label_source: None, printed_label_line_id: None }
    }).collect()
}

fn pack(value: serde_json::Value) -> u64 {
    let bytes = serde_json::to_vec(&value).unwrap().into_boxed_slice();
    let len = bytes.len() as u64;
    let ptr = Box::into_raw(bytes) as *mut u8 as u64;
    (len << 32) | ptr
}
