//! A read kept for a while across requests, in this process: the home page's policy values, promo
//! bar and counter, which change rarely and would otherwise be read again for every visitor that
//! carries a cookie (a cache in front keeps only the ones without). public-web keeps its policy
//! read five minutes the same way (`loadLandingFeePresentation`). Corten has no such cache
//! (todd-skelton/corten#121 asks for one); remove this when it does.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

/// The last good answer and when it was read. Only a successful read is kept, so a failure is
/// read again on the next request.
pub struct Kept<T> {
    life: Duration,
    slot: Mutex<Option<(Instant, T)>>,
}

impl<T: Clone> Kept<T> {
    pub const fn new(life: Duration) -> Self {
        Kept { life, slot: Mutex::new(None) }
    }

    /// The kept answer, while it is younger than its life.
    pub fn get(&self) -> Option<T> {
        let slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_ref().filter(|(at, _)| at.elapsed() < self.life).map(|(_, value)| value.clone())
    }

    pub fn put(&self, value: T) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), value));
    }

    /// The kept answer, or `read`'s, kept when it succeeds.
    pub async fn or_read<E>(&self, read: impl Future<Output = Result<T, E>>) -> Result<T, E> {
        if let Some(value) = self.get() {
            return Ok(value);
        }
        let value = read.await?;
        self.put(value.clone());
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::Kept;

    #[tokio::test]
    async fn a_good_read_is_kept_and_a_failure_is_not() {
        let kept = Kept::new(Duration::from_secs(60));
        assert_eq!(kept.or_read(async { Err::<u32, ()>(()) }).await, Err(()));
        assert_eq!(kept.or_read(async { Ok::<u32, ()>(1) }).await, Ok(1));
        assert_eq!(kept.or_read(async { Ok::<u32, ()>(2) }).await, Ok(1), "kept");
        let short = Kept::new(Duration::ZERO);
        short.put(1);
        assert_eq!(short.get(), None, "past its life");
    }
}
