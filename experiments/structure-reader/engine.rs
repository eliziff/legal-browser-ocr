use legal_pdf_core::{Line, Page, Span};
use legal_pdf_structure::{derive, StructureIdentity};
use legal_structure::{analyze_instrument, provider_text_document_structure, ProviderTextInput, ProviderTextSourceKind};
use serde::Deserialize;
use serde_json::json;

// Compile the exact pinned upstream postprocessor, without a maintained fork.
mod ppdoc {
    #[derive(Clone, serde::Deserialize, serde::Serialize)]
    pub struct PPDocDetection {
        #[serde(default)]
        pub label_id: usize,
        pub label: String,
        pub score: f32,
        pub bbox: [f32; 4],
        pub order: Option<usize>,
    }
}
mod inference {
    use image::RgbImage;
    use crate::ppdoc::PPDocDetection;
    include!(env!("LEGAL_BROWSER_INFERENCE"));

    pub fn pixels(rgb: Vec<u8>, width: u32, height: u32, variant: u32) -> Vec<f32> {
        let image = RgbImage::from_raw(width, height, rgb).expect("validated RGB length");
        if variant == 1 {
            resize_opencv_cubic_nchw(&image, 480, 480, 1.0 / 255.0, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
        } else {
            resize_opencv_cubic_nchw(&image, 800, 800, 1.0 / 255.0, [0.0; 3], [1.0; 3])
        }
    }
    pub fn boxes(values: &[f32], width: u32, height: u32, labels: &[String], threshold: f32) -> Vec<PPDocDetection> {
        postprocess(values, 6, values.len() / 6, labels, width, height, threshold)
    }
}
mod ppdoc_postprocess {
    include!(env!("LEGAL_BROWSER_POSTPROCESS"));
}

#[derive(Deserialize)]
struct BrowserInput { text: String, pages: Vec<BrowserPage> }
#[derive(Deserialize)]
struct BrowserPage {
    width: f64, height: f64, lines: Vec<BrowserLine>,
    #[serde(default)]
    layout: Option<BrowserLayout>,
}
#[derive(Deserialize)]
struct BrowserLayout {
    width: u32, height: u32, detections: Vec<ppdoc::PPDocDetection>,
}
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

// Byte-based allocations keep the worker ABI identical for pixels and JSON.
#[no_mangle]
pub unsafe extern "C" fn preprocess(ptr: *const u8, len: usize, width: u32, height: u32, variant: u32) -> u64 {
    if width == 0 || height == 0 || width > 4096 || height > 4096
        || variant > 1 || len != width as usize * height as usize * 3 { return 0; }
    let values = inference::pixels(std::slice::from_raw_parts(ptr, len).to_vec(), width, height, variant);
    let bytes = values.iter().flat_map(|value| value.to_le_bytes()).collect::<Vec<_>>();
    pack_bytes(bytes)
}

#[derive(Deserialize)]
struct DecodeInput { values: Vec<f32>, width: u32, height: u32, labels: Vec<String>, threshold: f32 }
#[no_mangle]
pub unsafe extern "C" fn decode_boxes(ptr: *const u8, len: usize) -> u64 {
    let result = serde_json::from_slice::<DecodeInput>(std::slice::from_raw_parts(ptr, len));
    pack(match result {
        Ok(input) if input.values.len() % 6 == 0 && input.values.len() <= 60_000 && (0.0..=1.0).contains(&input.threshold) =>
            json!({"detections": inference::boxes(&input.values, input.width, input.height, &input.labels, input.threshold)}),
        _ => json!({"error": "Invalid layout model output."}),
    })
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
        let mut regions = input.pages.iter().map(|page| page.layout.as_ref().map(|layout|
            ppdoc_postprocess::scale_detections(page.width, page.height, layout.width, layout.height, &layout.detections)
        )).collect::<Vec<_>>();
        let has_layout = regions.iter().any(Option::is_some);
        let mut pages = pdf_pages(input.pages);
        let mut layout_lines = Vec::new();
        let mut unmatched = Vec::new();
        if has_layout {
            if regions.iter().zip(&pages).any(|(region, page)| region.is_none() && !page.lines.is_empty()) {
                return json!({"error": "Layout analysis must cover every nonblank page."});
            }
            let mut regions = regions.drain(..).map(Option::unwrap_or_default).collect::<Vec<_>>();
            ppdoc_postprocess::postprocess_document(&pages, &mut regions);
            let mut pending = Vec::new();
            for (page_index, (page, regions)) in pages.iter().zip(&regions).enumerate() {
                for (line_index, line) in page.lines.iter().enumerate() {
                    let Some(index) = ppdoc_postprocess::best_region_index(line.bbox, regions) else {
                        unmatched.push(line.id.clone());
                        continue;
                    };
                    let label = regions[index].label.clone();
                    let region_id = format!("{}-ppdoc-r{:04}", page.id, regions[index].raw_index);
                    layout_lines.push(json!({"id": line.id, "region_id": region_id, "region_type": label}));
                    pending.push((page_index, line_index, label, region_id));
                }
            }
            // Same all-or-nothing parser input rule as upstream annotate_pdf.
            // The reader may still display the model's separate partial evidence.
            if unmatched.is_empty() {
                for (page_index, line_index, label, region_id) in pending {
                    let line = &mut pages[page_index].lines[line_index];
                    line.region_type = label;
                    line.region_id = region_id;
                }
            }
        }
        let separators = vec![None; pages.len()];
        return match derive(&mut pages, &separators, StructureIdentity {
            document_id: "browser-ocr".into(), source_sha256: String::new(),
        }) {
            Ok(output) => json!({"nodes": output.structure_graph.nodes, "offset_unit": output.structure_graph.offset_unit, "layout_lines": layout_lines,
                "layout_complete": has_layout && unmatched.is_empty(), "unclassified_lines": unmatched}),
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
                    // OCR ink bounds do not provide a font point size.
                    text: line.text, bbox, font: String::new(), size: 0.0, flags: 0,
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
    pack_bytes(serde_json::to_vec(&value).unwrap())
}
fn pack_bytes(bytes: Vec<u8>) -> u64 {
    let bytes = bytes.into_boxed_slice();
    let len = bytes.len() as u64;
    let ptr = Box::into_raw(bytes) as *mut u8 as u64;
    (len << 32) | ptr
}
