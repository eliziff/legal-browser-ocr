use legal_pdf_core::{OcrLine, OcrPageRequest, OcrPageResult, PdfOcrProvider};
pub use legal_pdf_core::profile;
use legal_pdf_extraction::ExtractedPdf;
use legal_pdf_structure::{derive, StructureIdentity};
use legal_structure::{analyze_instrument, provider_text_document_structure, ProviderTextInput, ProviderTextSourceKind};
use serde::Deserialize;
use serde_json::json;

#[no_mangle]
pub unsafe extern "C" fn extract_pdf(ptr: *const u8, len: usize) -> u64 {
    pack(match legal_pdf_extraction::extract_pdf(std::slice::from_raw_parts(ptr, len), None, None) {
        Ok(extracted) => json!(extracted),
        Err(error) => json!({"error": error.to_string()}),
    })
}

use legal_pdf_support::ppdoc_postprocess::{self, PPDocDetection};
mod inference {
    use image::RgbImage;
    use super::PPDocDetection;
    use legal_pdf_support::ppdoc_inference::{resize_opencv_cubic_nchw, postprocess};

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
#[derive(Deserialize)]
struct DetectionInput {
    extracted: ExtractedPdf,
    #[serde(default)] layouts: Option<Vec<Option<BrowserLayout>>>,
}
#[derive(Deserialize)]
struct BrowserLayout { width: u32, height: u32, detections: Vec<PPDocDetection>, #[serde(default)] separator_y: Option<f64> }

#[derive(Deserialize)]
struct OcrInput {width:f64,height:f64,lines:Vec<OcrLine>}
struct BrowserOcr(Vec<OcrInput>);
impl PdfOcrProvider for BrowserOcr {
    fn extract_pages(&mut self, _: &[u8], requests: &[OcrPageRequest]) -> legal_pdf_core::Result<Vec<OcrPageResult>> {
        Ok(requests.iter().map(|request| OcrPageResult {
            page_index: request.page_index,
            lines: self.0.get(request.page_index).map(|page|page.lines.iter().cloned().map(|mut line| {
                let sx=request.width/page.width;let sy=request.height/page.height;
                line.bbox=[line.bbox[0]*sx,line.bbox[1]*sy,line.bbox[2]*sx,line.bbox[3]*sy];line
            }).collect()).unwrap_or_default(),
            separator_y: None,
        }).collect())
    }
}
#[no_mangle]
pub unsafe extern "C" fn extract_ocr(pdf: *const u8, pdf_len: usize, input: *const u8, input_len: usize) -> u64 {
    let result = serde_json::from_slice::<Vec<OcrInput>>(std::slice::from_raw_parts(input,input_len));
    pack(match result {
        Ok(lines) => match legal_pdf_extraction::extract_pdf(std::slice::from_raw_parts(pdf,pdf_len),Some(&mut BrowserOcr(lines)),None) {
            Ok(extracted) => json!(extracted), Err(error) => json!({"error":error.to_string()}),
        },
        Err(error) => json!({"error":error.to_string()}),
    })
}

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

// Native OCR and browser OCR use the same raster witness scanner.
#[no_mangle]
pub unsafe extern "C" fn scan_separator(ptr: *const u8, len: usize, width: u32, height: u32) -> u64 {
    pack(json!(legal_pdf_ocr::raster_separator_y_from_gray(
        std::slice::from_raw_parts(ptr, len), width as usize, height as usize, 1.0,
    )))
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
        match serde_json::from_slice::<DetectionInput>(std::slice::from_raw_parts(ptr, len)) {
            Ok(input) => detect_input(input, profile),
            Err(_) => json!({"error": "Invalid OCR data."}),
        }
    };
    pack(response)
}

fn detect_input(mut input: DetectionInput, profile: u32) -> serde_json::Value {
    let pages = &mut input.extracted.pages;
    if profile == 0 {
        if let Some(layouts) = input.layouts {
            if layouts.len() != pages.len() { return json!({"error":"Layout page count mismatch"}); }
            for (index, (page, layout)) in pages.iter().zip(&layouts).enumerate() {
                if page.source == "ocr" {
                    if let Some(y) = layout.as_ref().and_then(|layout| layout.separator_y) {
                        input.extracted.separators[index] = Some(y * page.height);
                    }
                }
            }
            let count = layouts.iter().flatten().map(|layout|layout.detections.len()).sum();
            let regions = layouts.iter().zip(pages.iter()).map(|(layout,page)| layout.as_ref().map(|layout|
                ppdoc_postprocess::scale_detections(page.width,page.height,layout.width,layout.height,&layout.detections)
            ).unwrap_or_default()).collect();
            match ppdoc_postprocess::annotate_regions(pages,regions,count) {
                Ok(diagnostics) => input.extracted.diagnostics.extend(diagnostics),
                Err(error) => return json!({"error":error.to_string()}),
            }
        }
        return match derive(pages, &input.extracted.separators, StructureIdentity {
            document_id: "browser-pdf".into(), source_sha256: String::new(),
        }) {
            Ok(output) => {
                input.extracted.diagnostics.extend(output.diagnostics);
                json!({"nodes":output.structure_graph.nodes,"offset_unit":output.structure_graph.offset_unit,
                    "pages":pages,"diagnostics":input.extracted.diagnostics})
            },
            Err(error) => json!({"error":error.to_string()}),
        };
    }
    let text = pages.iter().map(|page|page.lines.iter().map(|line|line.text.as_str()).collect::<Vec<_>>().join("\n")+"\n").collect::<Vec<_>>().join("\n");
    let result = match profile {
        1 => provider_text_document_structure(ProviderTextInput::new("",ProviderTextSourceKind::Laws,&text)),
        2 => analyze_instrument(&text,"browser-pdf".into(),&[],false),
        _ => return json!({"error":"Unknown document profile"}),
    };
    match result {
        Ok(document) => json!({"nodes":document.nodes,"offset_unit":document.offset_unit,"pages":pages,"diagnostics":input.extracted.diagnostics}),
        Err(error) => json!({"error":error.to_string()}),
    }
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
