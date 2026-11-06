use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub protocol_version: u16,
    pub id: String,
    pub name: String,
    pub kind: String,
    pub version: String,
    pub capabilities: Vec<Capability>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub name: String,
    pub domain: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginRequest {
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub correlation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginResponse {
    pub request_id: String,
    #[serde(default)]
    pub result: Option<Value>,
    #[serde(default)]
    pub error: Option<PluginError>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginError {
    pub code: String,
}

impl PluginManifest {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err("unsupported plugin protocol version");
        }
        if self.id.is_empty() || self.name.is_empty() || self.version.is_empty() {
            return Err("plugin manifest identity fields must not be empty");
        }
        if self.capabilities.iter().any(|capability| {
            capability.name.is_empty() || capability.domain.is_empty()
        }) {
            return Err("plugin capabilities must declare a name and domain");
        }
        Ok(())
    }
}
