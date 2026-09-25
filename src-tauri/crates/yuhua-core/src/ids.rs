//! 类型化 ID。
//!
//! 问题：如果 book / volume / chapter 都用裸 String 表达 ID，
//! 那么 `assign_volume(book_id, chapter_id)` 这种参数写反的 bug
//! 编译器完全无法拦截，只能等到运行时数据错乱。
//!
//! 做法：newtype 包裹 + 编译期标签，让 `TypedId<Book>` 和 `TypedId<Chapter>`
//! 成为不同的类型。同时 ID 带人类可读前缀（bk_ / vol_ / ch_），
//! 在日志和数据库里一眼能看出这是什么东西。
//!
//! ID 生成使用 UUID v7：**时间有序**，因此按 ID 排序 ≈ 按创建时间排序，
//! 这对 SQLite 主键的 B 树插入局部性有实际好处。

use std::fmt;
use std::marker::PhantomData;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use uuid::Uuid;

/// ID 前缀标签 trait。
///
/// 实现者只需要给出一个短前缀；剩下的事情交给泛型。
pub trait IdPrefix: Sized {
    /// 该实体的 ID 前缀，例如章节是 `ch_`。
    const PREFIX: &'static str;
    /// 人类可读的实体名，用于错误信息与日志。
    const ENTITY: &'static str;
}

/// 书。ID 形如 `bk_0192f3a4...`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Book;
/// 卷。ID 形如 `vol_0192f3a4...`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Volume;
/// 章。ID 形如 `ch_0192f3a4...`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Chapter;

impl IdPrefix for Book {
    const PREFIX: &'static str = "bk_";
    const ENTITY: &'static str = "book";
}
impl IdPrefix for Volume {
    const PREFIX: &'static str = "vol_";
    const ENTITY: &'static str = "volume";
}
impl IdPrefix for Chapter {
    const PREFIX: &'static str = "ch_";
    const ENTITY: &'static str = "chapter";
}

/// 带编译期标签的 ID。
///
/// `PhantomData<fn() -> T>` 而不是 `PhantomData<T>`：
/// 前者不引入 T 的自动 trait 约束，也不会影响 Send/Sync 推断，
/// 是 newtype 标签的惯用手法。
pub struct TypedId<T: IdPrefix> {
    raw: String,
    _marker: PhantomData<fn() -> T>,
}

impl<T: IdPrefix> TypedId<T> {
    /// 生成一个新的、时间有序的 ID。
    pub fn new() -> Self {
        Self::from_uuid(Uuid::now_v7())
    }

    /// 由已有 UUID 构造（用于从数据库或 Front Matter 读回）。
    pub fn from_uuid(uuid: Uuid) -> Self {
        Self {
            raw: format!("{}{}", T::PREFIX, uuid.simple()),
            _marker: PhantomData,
        }
    }

    /// 按原始字符串构造，并校验前缀。
    ///
    /// 前缀校验不是吹毛求疵：Front Matter 是用户可以直接编辑的文件，
    /// 手滑把卷 ID 复制到章节里是很现实的操作，这里要挡住。
    pub fn parse(raw: impl Into<String>) -> Result<Self, String> {
        let raw = raw.into();
        if !raw.starts_with(T::PREFIX) {
            return Err(format!(
                "ID 前缀不匹配：期望 {} 开头，实际是 {:?}",
                T::PREFIX,
                raw.chars().take(8).collect::<String>()
            ));
        }
        if raw.len() <= T::PREFIX.len() {
            return Err(format!("ID 缺少主体部分：{raw:?}"));
        }
        Ok(Self {
            raw,
            _marker: PhantomData,
        })
    }

    /// 不做前缀校验地构造。仅用于已知来源可信的场景（如内部常量）。
    pub fn from_raw_unchecked(raw: impl Into<String>) -> Self {
        Self {
            raw: raw.into(),
            _marker: PhantomData,
        }
    }

    /// 取原始字符串。
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// 转成拥有所有权的字符串。
    pub fn into_string(self) -> String {
        self.raw
    }
}

impl<T: IdPrefix> Default for TypedId<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: IdPrefix> Clone for TypedId<T> {
    fn clone(&self) -> Self {
        Self {
            raw: self.raw.clone(),
            _marker: PhantomData,
        }
    }
}

impl<T: IdPrefix> PartialEq for TypedId<T> {
    fn eq(&self, other: &Self) -> bool {
        self.raw == other.raw
    }
}
impl<T: IdPrefix> Eq for TypedId<T> {}

impl<T: IdPrefix> std::hash::Hash for TypedId<T> {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.raw.hash(state);
    }
}

impl<T: IdPrefix> fmt::Display for TypedId<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.raw)
    }
}

impl<T: IdPrefix> fmt::Debug for TypedId<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}Id({})", T::ENTITY, self.raw)
    }
}

impl<T: IdPrefix> Serialize for TypedId<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.raw)
    }
}

impl<'de, T: IdPrefix> Deserialize<'de> for TypedId<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::parse(raw).map_err(serde::de::Error::custom)
    }
}

/// 书 ID 的类型别名。
pub type BookId = TypedId<Book>;
/// 卷 ID 的类型别名。
pub type VolumeId = TypedId<Volume>;
/// 章 ID 的类型别名。
pub type ChapterId = TypedId<Chapter>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_id_has_entity_prefix() {
        let id = ChapterId::new();
        assert!(id.as_str().starts_with("ch_"), "got {id}");
        // ENTITY 定义在 IdPrefix trait 上，需要把 trait 带进作用域才能访问
        assert_eq!(<Chapter as IdPrefix>::ENTITY, "chapter");
    }

    #[test]
    fn ids_are_unique() {
        let a = ChapterId::new();
        let b = ChapterId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn parse_rejects_wrong_prefix() {
        // 把卷 ID 误当成章节 ID 使用时必须报错，而不是静默接受
        let vol = VolumeId::new();
        let err = ChapterId::parse(vol.as_str()).unwrap_err();
        assert!(err.contains("前缀不匹配"), "got {err}");
    }

    #[test]
    fn parse_rejects_prefix_only() {
        assert!(ChapterId::parse("ch_").is_err());
    }

    #[test]
    fn roundtrips_through_json() {
        let id = BookId::new();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{}\"", id.as_str()));
        let back: BookId = serde_json::from_str(&json).unwrap();
        assert_eq!(id, back);
    }

    #[test]
    fn id_is_time_ordered() {
        // UUID v7 的核心好处：生成顺序 == 字典序，SQLite 主键插入有局部性
        let a = ChapterId::new();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = ChapterId::new();
        assert!(a.as_str() < b.as_str(), "{a} should sort before {b}");
    }
}
